/**
 * Phase 1201 Step A: per-contract progress mutation queue primitive.
 *
 * Reverse acceptance (deterministic, deferred-promise barriers, no sleep):
 * 1. same contract 严格 FIFO；
 * 2. different contract 并行进入；
 * 3. first reject 后 second 仍执行（reject 隔离），caller 收到原始 reject；
 * 4. settle 后 entry 回收（size 0）；
 * 5. old tail finally 不删除 new tail（identity-safe cleanup）；
 * 6. owner 装配：ContractSystem._enqueueProgressMutation 走同一 queue + audit。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ProgressMutationQueue,
  type ProgressMutationMeta,
} from '../../../src/core/contract/progress-mutation-queue.js';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function meta(kind: ProgressMutationMeta['kind'], id: string): ProgressMutationMeta {
  return { mutationId: id, kind };
}

const C_A = makeContractId('contract-a');
const C_B = makeContractId('contract-b');

describe('ProgressMutationQueue (phase 1201 step A)', () => {
  it('same contract mutations run in strict FIFO order', async () => {
    const queue = new ProgressMutationQueue(makeMockAudit());
    const order: string[] = [];
    const gateA = deferred();

    const pA = queue.enqueue(C_A, meta('sync_complete', 'm1'), async () => {
      order.push('a:start');
      await gateA.promise;
      order.push('a:end');
      return 'ra';
    });
    let bEntered = false;
    const pB = queue.enqueue(C_A, meta('attempt_start', 'm2'), async () => {
      bEntered = true;
      order.push('b:start');
      return 'rb';
    });

    // B is queued but must not enter while A holds the tail.
    await Promise.resolve();
    expect(bEntered).toBe(false);
    expect(queue.pendingCount(C_A)).toBe(2);

    gateA.resolve();
    await expect(pA).resolves.toBe('ra');
    await expect(pB).resolves.toBe('rb');
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('different contracts enter in parallel', async () => {
    const queue = new ProgressMutationQueue(makeMockAudit());
    const gateA = deferred();
    const gateB = deferred();
    let aEntered = false;
    let bEntered = false;

    const pA = queue.enqueue(C_A, meta('sync_complete', 'm1'), async () => {
      aEntered = true;
      await gateA.promise;
    });
    const pB = queue.enqueue(C_B, meta('sync_complete', 'm2'), async () => {
      bEntered = true;
      await gateB.promise;
    });

    // Both callbacks entered before either resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(aEntered).toBe(true);
    expect(bEntered).toBe(true);

    gateB.resolve();
    gateA.resolve();
    await Promise.all([pA, pB]);
  });

  it('a rejecting mutation does not poison the following tail; caller gets original rejection', async () => {
    const queue = new ProgressMutationQueue(makeMockAudit());
    const boom = new Error('boom');
    let secondRan = false;

    const p1 = queue.enqueue(C_A, meta('sync_complete', 'm1'), async () => {
      throw boom;
    });
    const p2 = queue.enqueue(C_A, meta('attempt_start', 'm2'), async () => {
      secondRan = true;
      return 'ok';
    });

    await expect(p1).rejects.toBe(boom);
    await expect(p2).resolves.toBe('ok');
    expect(secondRan).toBe(true);
    expect(queue.trackedContractCount).toBe(0);
  });

  it('entries are reclaimed after settle (size back to 0)', async () => {
    const queue = new ProgressMutationQueue(makeMockAudit());
    await queue.enqueue(C_A, meta('sync_complete', 'm1'), async () => 1);
    await queue.enqueue(C_B, meta('sync_complete', 'm2'), async () => 2);
    expect(queue.pendingCount(C_A)).toBe(0);
    expect(queue.pendingCount(C_B)).toBe(0);
    expect(queue.trackedContractCount).toBe(0);
  });

  it('old tail finally must not delete the newer tail entry', async () => {
    const queue = new ProgressMutationQueue(makeMockAudit());
    const gateA = deferred();
    const gateB = deferred();

    const pA = queue.enqueue(C_A, meta('sync_complete', 'm1'), async () => {
      await gateA.promise;
    });
    const pB = queue.enqueue(C_A, meta('sync_complete', 'm2'), async () => {
      await gateB.promise;
    });

    gateA.resolve();
    await pA;
    // A settled and ran its cleanup while B still pending: B's entry must survive.
    expect(queue.pendingCount(C_A)).toBe(1);
    expect(queue.trackedContractCount).toBe(1);

    gateB.resolve();
    await pB;
    expect(queue.trackedContractCount).toBe(0);
  });

  it('emits queued/started/finished audit with mutation id, kind and depth', async () => {
    const audit = makeMockAudit();
    const queue = new ProgressMutationQueue(audit);
    const gate = deferred();
    const p1 = queue.enqueue(C_A, meta('sync_complete', 'm1'), async () => {
      await gate.promise;
    });
    const p2 = queue.enqueue(C_A, meta('apply_outcome', 'm2'), async () => 'done');

    gate.resolve();
    await p1;
    await p2;

    const writes = vi.mocked(audit.write).mock.calls;
    const byType = (t: string) => writes.filter(c => c[0] === t);
    expect(byType(CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_QUEUED)).toEqual([
      [CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_QUEUED, 'contractId=contract-a', 'mutationId=m1', 'kind=sync_complete', 'depth=1'],
      [CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_QUEUED, 'contractId=contract-a', 'mutationId=m2', 'kind=apply_outcome', 'depth=2'],
    ]);
    expect(byType(CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_STARTED)).toHaveLength(2);
    expect(byType(CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_FINISHED)).toHaveLength(2);
    expect(byType(CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_FAILED)).toHaveLength(0);
  });

  it('emits failed audit with error fact on rejection', async () => {
    const audit = makeMockAudit();
    const queue = new ProgressMutationQueue(audit);
    await expect(
      queue.enqueue(C_A, meta('boot_reset', 'm9'), async () => {
        throw new Error('disk gone');
      }),
    ).rejects.toThrow('disk gone');

    const writes = vi.mocked(audit.write).mock.calls;
    const failed = writes.filter(c => c[0] === CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('mutationId=m9');
    expect(failed[0].some(c => typeof c === 'string' && c.startsWith('error='))).toBe(true);
  });
});

describe('ContractSystem progress mutation queue owner wiring (phase 1201 step A)', () => {
  it('manager owns the queue and exposes the enqueue delegate + depth observability', async () => {
    const tempDir = await createTempDir('phase1201-queue-');
    try {
      const audit = makeMockAudit();
      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'claw-queue',
        fs: new NodeFileSystem({ baseDir: tempDir }),
        audit,
        notifyClaw: () => Promise.resolve(),
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      });

      const gate = deferred();
      const p1 = manager._enqueueProgressMutation(C_A, meta('sync_complete', 'm1'), async () => {
        await gate.promise;
        return 'r1';
      });
      const p2 = manager._enqueueProgressMutation(C_A, meta('attempt_start', 'm2'), async () => 'r2');

      expect(manager.progressMutationQueueDepth(C_A)).toBe(2);
      gate.resolve();
      await expect(p1).resolves.toBe('r1');
      await expect(p2).resolves.toBe('r2');
      expect(manager.progressMutationQueueDepth(C_A)).toBe(0);

      const writes = vi.mocked(audit.write).mock.calls;
      expect(writes.some(c => c[0] === CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_QUEUED)).toBe(true);
      expect(writes.some(c => c[0] === CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_FINISHED)).toBe(true);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it('reverse: enqueueing with a different contract id does not share the same FIFO tail', async () => {
    const tempDir = await createTempDir('phase1201-queue-');
    try {
      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'claw-queue',
        fs: new NodeFileSystem({ baseDir: tempDir }),
        audit: makeMockAudit(),
        notifyClaw: () => Promise.resolve(),
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      });

      const gateA = deferred();
      let bEntered = false;
      const pA = manager._enqueueProgressMutation(C_A, meta('sync_complete', 'm1'), async () => {
        await gateA.promise;
      });
      const pB = manager._enqueueProgressMutation(C_B, meta('sync_complete', 'm2'), async () => {
        bEntered = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(bEntered).toBe(true);
      gateA.resolve();
      await Promise.all([pA, pB]);
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});
