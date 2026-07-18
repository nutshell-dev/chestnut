/**
 * ContractSystem dispose / cancel / pause verifier invariants — merged test file
 *
 * Sources:
 * - dispose-await-verifier.test.ts
 * - cancel-save-before-abort.test.ts
 * - cancel-signal-propagation.test.ts
 * - pause-abort-verifier.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeAudit, makeMockAudit, waitForNextAuditEvent, waitForNthAuditEvent } from '../../helpers/audit.js';
import { waitFor } from '../../helpers/wait-for.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';

const { mockRunContractVerifierDispose } = vi.hoisted(() => ({
  mockRunContractVerifierDispose: vi.fn(),
}));

const { mockRunContractVerifier } = vi.hoisted(() => ({
  mockRunContractVerifier: vi.fn(),
}));

vi.mock('../../../src/core/contract/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/contract/constants.js')>();
  return {
    ...actual,
    LOCK_MAX_RETRIES: 3,
    LOCK_RETRY_DELAY_MS: 10,
  };
});

vi.mock('../../../src/core/contract/verifier-job.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/contract/verifier-job.js')>();
  return {
    ...mod,
    runContractVerifier: mockRunContractVerifierDispose,
  };
});

// ───── source: dispose-await-verifier.test.ts ─────
/**
 * @module tests/core/contract/dispose-await-verifier
 * Phase 1335 sub-3: ContractSystem.close() async + await verifier termination
 */
describe('ContractSystem.close() async await verifier termination', () => {
  /**
   * Promise barrier releases for ordered close() simulation.
   * cs1 must complete after cs2; release order is controlled explicitly below.
   */
  let cs1Release: (() => void) | undefined;
  let cs2Release: (() => void) | undefined;

  let testDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  let emitter: EventEmitter;

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-contract-dispose-async-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    // phase 376: makeAudit 拿 emitter、test 用 waitForNextAuditEvent 替原 polling
    const { audit: mockAudit, emitter: em } = makeAudit();
    emitter = em;
    const mockLlm = { id: 'mock-llm' } as any;
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      llm: mockLlm,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
    mockRunContractVerifierDispose.mockReset();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    vi.restoreAllMocks();
  });

  it('close() await 完成前 verifier subagent abort 真停', async () => {
    const contractId = await manager.create({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
    });

    await fs.mkdir(path.join(clawDir, 'contract/active', contractId, 'verification'), { recursive: true });
    await fs.writeFile(
      path.join(clawDir, 'contract/active', contractId, 'verification', 't1.prompt.txt'),
      'Check: {{evidence}}',
    );

    let resolveVerifier: (() => void) | undefined;
    let aborted = false;

    mockRunContractVerifierDispose.mockImplementation(async (config: { signal?: AbortSignal }) => {
      config.signal?.addEventListener('abort', () => {
        aborted = true;
      }, { once: true });
      return new Promise((resolve) => {
        resolveVerifier = () => resolve({ passed: true, feedback: 'ok' });
      });
    });

    // phase 376: 订阅 VERIFIER_REGISTERED 之前触发 verification
    const verifierRegistered = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFIER_REGISTERED);
    (manager as any).runLLMVerification(
      'verification/t1.prompt.txt',
      path.join(clawDir, 'contract/active', contractId),
      contractId,
      't1',
      'T1',
      'evidence',
      [],
    ).catch(() => { /* silent: shutdown */ });

    await verifierRegistered;

    const closePromise = manager.close();
    expect(aborted).toBe(true);
    expect(manager.getActiveVerifierCount()).toBeGreaterThanOrEqual(1);

    resolveVerifier!();
    await closePromise;

    expect(manager.getActiveVerifierCount()).toBe(0);
  });

  it('disposeContractSystems 顺序：await close 完成才遍历完', async () => {
    const closeOrder: string[] = [];
    const cs1 = manager;
    const cs2 = new ContractSystem({
      clawDir,
      clawId: 'test-claw-2',
      fs: nodeFs,
      audit: makeMockAudit() as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    vi.spyOn(cs1, 'close').mockImplementation(async () => {
      closeOrder.push('cs1-start');
      await new Promise<void>(r => { cs1Release = r; });
      closeOrder.push('cs1-end');
    });
    vi.spyOn(cs2, 'close').mockImplementation(async () => {
      closeOrder.push('cs2-start');
      await new Promise<void>(r => { cs2Release = r; });
      closeOrder.push('cs2-end');
    });

    const cache = new Map<string, ContractSystem>();
    cache.set('claw-1', cs1);
    cache.set('claw-2', cs2);

    const closePromise = (async () => {
      for (const cs of cache.values()) {
        await cs.close();
      }
      cache.clear();
    })();

    // cs1 is called first by the loop; release it so cs1-end is recorded and the loop proceeds to cs2.
    await waitFor(() => closeOrder.includes('cs1-start'), 1000);
    cs1Release!();

    // cs2 is now called; release it so cs2-end is recorded.
    await waitFor(() => closeOrder.includes('cs2-start'), 1000);
    cs2Release!();

    await closePromise;

    expect(closeOrder).toEqual(['cs1-start', 'cs1-end', 'cs2-start', 'cs2-end']);
  });
});

// ───── source: cancel-save-before-abort.test.ts ─────
/**
 * Phase 1152 G.5: cancelContract saveProgress-before-abort op-order reverse tests
 */
describe('phase 1152 G.5: cancelContract saveProgress before abort order', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const captureAudit = {
      write: () => {},
    };
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('phase 63: cancelContract triggers safeNotify("contract_cancelled")', async () => {
    const notifyCalls: Array<{ type: string; data: Record<string, unknown> }> = [];
    manager.setOnNotify((type, data) => {
      notifyCalls.push({ type, data });
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Cancel Notify Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
    // create triggers contract_created notify, clear to only verify cancel
    notifyCalls.length = 0;

    await manager.cancel(contractId, 'user cancelled');

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].type).toBe('contract_cancelled');
    expect(notifyCalls[0].data).toMatchObject({
      contractId,
      reason: 'user cancelled',
    });
  });

  // 反向 1: happy path — cancelContract 后 progress.json status='cancelled' + contract 在 archive dir
  it('happy path: cancel saves progress as cancelled then moves to archive', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancel Order Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await manager.cancel(contractId, 'user cancelled');

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('cancelled');
    expect(progress.checkpoint).toBe('cancelled: user cancelled');

    // contract should be in archive/cancelled dir
    const archiveContractDir = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    await expect(fs.access(archiveContractDir)).resolves.toBeUndefined();
  });

  // 反向 2: abortContractVerifiers throws → catch 不阻断 → saveProgress 已 land + fs.move 仍执行
  it('abort throw: saveProgress lands before abort, catch does not block move', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancel Abort Throw Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const abortSpy = vi.spyOn(manager as any, '_abortContractVerifiers').mockImplementation(() => {
      throw new Error('verifier abort boom');
    });

    // Should NOT throw — abort is best-effort wrapped in try/catch
    await expect(manager.cancel(contractId, 'test abort throw')).resolves.toBeUndefined();

    // saveProgress must have landed before abort was called
    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('cancelled');

    // contract should still be moved to archive
    const archiveContractDir = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    await expect(fs.access(archiveContractDir)).resolves.toBeUndefined();

    abortSpy.mockRestore();
  });

  // 反向 3: saveProgress reject → catch 块 releaseLock(source) + throw / lock 不 orphan
  it('saveProgress reject: source lock released + throw propagated', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancel Save Reject Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const sourceLockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');

    const saveSpy = vi.spyOn(manager as any, 'saveProgress').mockRejectedValue(
      new Error('ENOSPC: no space left on device')
    );

    await expect(manager.cancel(contractId, 'test save reject')).rejects.toThrow('ENOSPC');

    // source lock must be released (deleted)
    await expect(fs.access(sourceLockPath)).rejects.toThrow();

    saveSpy.mockRestore();
  });
});

// ───── source: cancel-signal-propagation.test.ts ─────
/**
 * phase 1020 / r124 C fork — cancel propagation 装配端真实施
 *
 * 反向 3 项:
 * 1. cancel 真 propagate verifier subagent abort
 * 2. verifier 完成后 controller 自动 unregister（cleanup invariant）
 * 3. 同 contract 多 verifier 并发，cancel abort 全部
 */
describe('phase 1020 / r124 C fork — cancel propagation 装配端真实施', () => {
  let testDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  let emitter: EventEmitter;

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-cancel-prop-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    // phase 376: makeAudit 拿 emitter、test 用 waitForNextAuditEvent 替原 polling
    const { audit: mockAudit, emitter: em } = makeAudit();
    emitter = em;
    const mockLlm = { id: 'mock-llm' } as any;
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      llm: mockLlm,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      runContractVerifier: mockRunContractVerifier,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
    mockRunContractVerifier.mockReset();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    vi.restoreAllMocks();
  });

  // ───── 反向 1: cancel 真 propagate verifier subagent abort ─────
  describe('反向 1: cancel 真 propagate verifier subagent abort', () => {
    it('cancelContract 触发后 active verifier signal aborted', async () => {
      const contractId = await manager.create(makeContractYaml({
        title: 'Test',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
      }));

      await fs.mkdir(path.join(clawDir, 'contract/active', contractId, 'verification'), { recursive: true });
      await fs.writeFile(
        path.join(clawDir, 'contract/active', contractId, 'verification', 't1.prompt.txt'),
        'Check: {{evidence}}',
      );

      mockRunContractVerifier.mockImplementation(async (config: { signal?: AbortSignal }) => {
        return new Promise((_, reject) => {
          const onAbort = () => reject(new Error('AbortError: signal aborted'));
          if (config.signal?.aborted) {
            onAbort();
            return;
          }
          config.signal?.addEventListener('abort', onAbort);
        });
      });

      // phase 376: 订阅 VERIFIER_REGISTERED 之前触发 runLLMVerification 会漏抓、必先订阅
      const verifierRegistered = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFIER_REGISTERED);
      const verifierPromise = (manager as any).runLLMVerification(
        'verification/t1.prompt.txt',
        path.join(clawDir, 'contract/active', contractId),
        contractId,
        't1',
        'T1',
        'evidence',
        [],
      );

      await verifierRegistered;

      await manager.cancel(contractId, 'test reason');

      const result = await verifierPromise;
      expect(result.passed).toBe(false);
      expect(result.feedback).toContain('AbortError');
    });
  });

  // ───── 反向 2: cleanup invariant — verifier 完成后 controller 自动 unregister ─────
  describe('反向 2: cleanup invariant — verifier 完成后 controller 自动 unregister', () => {
    it('verifier resolve 后 _activeContractControllers Map 不 leak', async () => {
      const contractId = await manager.create(makeContractYaml({
        title: 'Test',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
      }));

      await fs.mkdir(path.join(clawDir, 'contract/active', contractId, 'verification'), { recursive: true });
      await fs.writeFile(
        path.join(clawDir, 'contract/active', contractId, 'verification', 't1.prompt.txt'),
        'Check: {{evidence}}',
      );

      let resolveVerifier!: (value: { passed: boolean; feedback: string }) => void;
      mockRunContractVerifier.mockImplementation(async () => {
        return new Promise((resolve) => {
          resolveVerifier = resolve;
        });
      });

      // phase 376: 订阅 VERIFIER_REGISTERED 之前触发 runLLMVerification 会漏抓、必先订阅
      const verifierRegistered = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFIER_REGISTERED);
      const promise = (manager as any).runLLMVerification(
        'verification/t1.prompt.txt',
        path.join(clawDir, 'contract/active', contractId),
        contractId,
        't1',
        'T1',
        'evidence',
        [],
      );

      await verifierRegistered;

      const controllers = (manager as any)._activeContractControllers;
      expect(controllers.get(contractId)).toBeDefined();
      expect(controllers.get(contractId).size).toBe(1);

      // 让 verifier 完成
      resolveVerifier({ passed: true, feedback: 'ok' });
      await promise;

      // finally unregister 后 Map 应清空
      expect(controllers.get(contractId)).toBeUndefined();
    });
  });

  // ───── 反向 3: multi-verifier same contract — 1 cancel abort 全部 controller ─────
  describe('反向 3: multi-verifier same contract — 1 cancel abort 全部', () => {
    it('同 contractId 2 并发 verifier、1 cancel abort 全部', async () => {
      const contractId = await manager.create(makeContractYaml({
        title: 'Test',
        goal: 'Test',
        subtasks: [
          { id: 't1', description: 'T1' },
          { id: 't2', description: 'T2' },
        ],
        verification: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' },
          { subtask_id: 't2', type: 'llm', prompt_file: 'verification/t2.prompt.txt' },
        ],
      }));

      await fs.mkdir(path.join(clawDir, 'contract/active', contractId, 'verification'), { recursive: true });
      await fs.writeFile(
        path.join(clawDir, 'contract/active', contractId, 'verification', 't1.prompt.txt'),
        'Check: {{evidence}}',
      );
      await fs.writeFile(
        path.join(clawDir, 'contract/active', contractId, 'verification', 't2.prompt.txt'),
        'Check: {{evidence}}',
      );

      mockRunContractVerifier.mockImplementation(async (config: { signal?: AbortSignal }) => {
        return new Promise((_, reject) => {
          const onAbort = () => reject(new Error('AbortError: signal aborted'));
          if (config.signal?.aborted) {
            onAbort();
            return;
          }
          config.signal?.addEventListener('abort', onAbort);
        });
      });

      // phase 376: 订阅 VERIFIER_REGISTERED ×2 之前触发 2 个 verifier、避 race
      const twoVerifiersRegistered = waitForNthAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFIER_REGISTERED, 2);
      const p1 = (manager as any).runLLMVerification(
        'verification/t1.prompt.txt',
        path.join(clawDir, 'contract/active', contractId),
        contractId,
        't1',
        'T1',
        'evidence',
        [],
      );
      const p2 = (manager as any).runLLMVerification(
        'verification/t2.prompt.txt',
        path.join(clawDir, 'contract/active', contractId),
        contractId,
        't2',
        'T2',
        'evidence',
        [],
      );

      await twoVerifiersRegistered;

      await manager.cancel(contractId, 'test');

      const r1 = await p1;
      const r2 = await p2;
      expect(r1.passed).toBe(false);
      expect(r1.feedback).toContain('AbortError');
      expect(r2.passed).toBe(false);
      expect(r2.feedback).toContain('AbortError');
    });
  });
});


