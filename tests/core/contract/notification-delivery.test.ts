import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { ContractNotification } from '../../../src/core/contract/notification.js';
import { makeContractId, makeSubtaskId } from '../../../src/core/contract/types.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeClawId } from '../../../src/foundation/claw-identity/index.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

describe('Phase 2193 C2: durable contract notification delivery', () => {
  let root: string;
  let clawDir: string;
  let audit: ReturnType<typeof makeMockAudit>;

  beforeEach(async () => {
    root = await createTrackedTempDir('phase2193-notification-delivery-');
    clawDir = path.join(root, 'claws', 'worker-1');
    await fs.mkdir(clawDir, { recursive: true });
    audit = makeMockAudit();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await cleanupTempDir(root);
  });

  function makeManager(
    onNotify?: (event: ContractNotification) => void,
    fsImpl = new NodeFileSystem({ baseDir: clawDir }),
  ): ContractSystem {
    return new ContractSystem({
      clawDir,
      clawId: makeClawId('worker-1'),
      fs: fsImpl,
      audit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      notifyClaw: vi.fn(),
      deliverCancellation: async () => {},
      onNotify,
    });
  }

  function cancelled(contractId = 'c1'): ContractNotification {
    return { type: 'contract_cancelled', contractId: makeContractId(contractId), reason: 'stop' };
  }

  async function outboxFiles(state: 'pending' | 'done'): Promise<string[]> {
    try {
      return (await fs.readdir(path.join(clawDir, 'contract', 'notification-outbox', state)))
        .filter(name => name.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  it('deduplicates a completed delivery by stable messageId', () => {
    const sink = vi.fn();
    const manager = makeManager(sink);
    const event = cancelled();

    manager.onNotify!(event);
    manager.onNotify!(event);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({
      stateRevision: 1,
      messageId: 'contract:c1:contract_cancelled',
      idempotencyKey: 'contract:c1:contract_cancelled',
      occurredAt: expect.any(String),
    });
  });

  it('reuses the original revision and occurredAt when a pending sink call is retried', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-11-18T00:00:00.000Z');
    const received: ContractNotification[] = [];
    let fail = true;
    const manager = makeManager(event => {
      received.push(event);
      if (fail) throw new Error('SINK_EIO');
    });
    const event = cancelled();

    expect(() => manager.onNotify!(event)).toThrow('SINK_EIO');
    vi.setSystemTime('2026-11-18T01:00:00.000Z');
    fail = false;
    manager.onNotify!(event);

    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(received[0]);
    expect(received[0]).toMatchObject({
      stateRevision: 1,
      occurredAt: '2026-11-18T00:00:00.000Z',
    });
  });

  it('allocates monotonic per-contract revisions, including after restart', () => {
    const firstSink = vi.fn();
    const manager = makeManager(firstSink);
    manager.onNotify!({
      type: 'contract_created',
      contractId: makeContractId('c1'),
      title: 'T',
      subtaskCount: 1,
      createdAt: '2026-11-18T00:00:00.000Z',
    });
    manager.onNotify!({
      type: 'subtask_completed',
      contractId: makeContractId('c1'),
      subtaskId: makeSubtaskId('t1'),
    });
    manager.onNotify!(cancelled('c2'));

    expect(firstSink.mock.calls.map(call => call[0].stateRevision)).toEqual([1, 2, 1]);

    const restartedSink = vi.fn();
    const restarted = makeManager(restartedSink);
    restarted.onNotify!({
      type: 'contract_failed',
      contractId: makeContractId('c1'),
      reason: 'executor unavailable',
      evidenceRef: 'executor/events.jsonl#1',
      producer: 'test',
    });
    expect(restartedSink.mock.calls[0][0].stateRevision).toBe(3);
  });

  it('replays pending exactly from its durable record on restart', async () => {
    const first = makeManager(() => { throw new Error('CRASH_AFTER_PENDING'); });
    expect(() => first.onNotify!(cancelled())).toThrow('CRASH_AFTER_PENDING');
    expect(await outboxFiles('pending')).toHaveLength(1);

    const recovered = vi.fn();
    const restarted = makeManager(recovered);
    await restarted.init();

    expect(recovered).toHaveBeenCalledTimes(1);
    expect(recovered.mock.calls[0][0]).toMatchObject({
      type: 'contract_cancelled',
      stateRevision: 1,
      occurredAt: expect.any(String),
    });
    expect(await outboxFiles('pending')).toHaveLength(0);
    expect(await outboxFiles('done')).toHaveLength(1);

    await restarted.init();
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('keeps malformed pending evidence and audits it instead of silently dropping it', async () => {
    const pendingDir = path.join(clawDir, 'contract', 'notification-outbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(path.join(pendingDir, 'broken.json'), '{not-json');
    const sink = vi.fn();

    await makeManager(sink).init();

    expect(sink).not.toHaveBeenCalled();
    expect(await outboxFiles('pending')).toEqual(['broken.json']);
    expect(audit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.NOTIFICATION_OUTBOX_MALFORMED,
      expect.stringContaining('broken.json'),
      expect.stringContaining('invalid notification outbox record'),
    );
  });

  it('does not roll back committed business state when the sink fails and can retry delivery', async () => {
    const received: ContractNotification[] = [];
    let fail = true;
    const manager = makeManager(event => {
      received.push(event);
      if (fail) throw new Error('CONTEXT_INBOX_EIO');
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Durable state',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await expect(fs.access(path.join(clawDir, 'contract', 'active', contractId))).resolves.toBeUndefined();
    expect(await outboxFiles('pending')).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'contract_created', stateRevision: 1 });

    fail = false;
    manager.onNotify!({
      type: 'contract_created',
      contractId: makeContractId(contractId),
      title: 'retry input cannot replace the durable event',
      subtaskCount: 99,
      createdAt: '2026-01-01T00:00:00.000Z',
      messageId: `contract:${contractId}:created`,
      idempotencyKey: `contract:${contractId}:contract_created`,
    });

    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(received[0]);
    expect(received[1]).toMatchObject({ title: 'Durable state', subtaskCount: 1 });
    expect(await outboxFiles('done')).toHaveLength(1);
  });

  it('does not call the sink when the write-ahead persist fails and permits a later retry', () => {
    const fsImpl = new NodeFileSystem({ baseDir: clawDir });
    const writeAtomicSync = fsImpl.writeAtomicSync.bind(fsImpl);
    let fail = true;
    vi.spyOn(fsImpl, 'writeAtomicSync').mockImplementation((target, content) => {
      if (fail && target.includes('notification-outbox')) throw new Error('OUTBOX_WRITE_EIO');
      return writeAtomicSync(target, content);
    });
    const sink = vi.fn();
    const manager = makeManager(sink, fsImpl);

    expect(() => manager.onNotify!(cancelled())).toThrow('OUTBOX_WRITE_EIO');
    expect(sink).not.toHaveBeenCalled();

    fail = false;
    manager.onNotify!(cancelled());
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].stateRevision).toBe(1);
  });

  it('does not create an outbox when no sink is configured', async () => {
    const manager = makeManager();
    await manager.create(makeContractYaml());
    expect(await outboxFiles('pending')).toEqual([]);
    expect(await outboxFiles('done')).toEqual([]);
  });
});
