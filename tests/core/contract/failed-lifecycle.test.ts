/**
 * Phase 1396 Step D: ContractSystem-owned `failed` terminal lifecycle.
 *
 * `active/<id> → archive/failed/<id>` is an independent terminal state persisted
 * with reason/evidenceRef/producer via the immutable lifecycle intent store and
 * the rename-winner protocol. cancelled stays reserved for explicit business
 * cancellation; execution failure must never be expressed as cancelled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import type { ContractNotification } from '../../../src/core/contract/notification.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import {
  buildFailedIntent,
  persistLifecycleIntent,
} from '../../../src/core/contract/lifecycle-intent.js';
import type { ContractId, ContractFailure } from '../../../src/core/contract/types.js';

const EXECUTOR_ID = 'test-claw';

interface Fixture {
  tempDir: string;
  clawDir: string;
  manager: ContractSystem;
  notifies: ContractNotification[];
  audit: { write: ReturnType<typeof vi.fn> };
  auditWrite: ReturnType<typeof vi.fn>;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function setup(): Promise<Fixture> {
  const tempDir = await createTempDir('phase1396-failed-');
  const clawDir = path.join(tempDir, 'claws', EXECUTOR_ID);
  await fs.mkdir(clawDir, { recursive: true });

  const notifies: ContractNotification[] = [];
  const auditWrite = vi.fn();
  const audit = { write: auditWrite, preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as any;
  const manager = new ContractSystem({
    clawDir,
    clawId: EXECUTOR_ID,
    fs: new NodeFileSystem({ baseDir: clawDir }),
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: path.join(tempDir, 'claws'),
    notifyClaw: () => Promise.resolve(),
  });
  manager.setOnNotify((event) => notifies.push(event));

  return { tempDir, clawDir, manager, notifies, audit, auditWrite };
}

const FAILURE: ContractFailure = {
  reason: 'executor process died',
  evidenceRef: 'executor/events.jsonl#seq=42',
  producer: 'event-loop',
};

function failedAuditCalls(fx: Fixture) {
  return fx.auditWrite.mock.calls.filter((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.FAILED);
}

function cancelledAuditCalls(fx: Fixture) {
  return fx.auditWrite.mock.calls.filter((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CANCELLED);
}

describe('Phase 1396 Step D: ContractSystem.fail', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await setup();
  });

  afterEach(async () => {
    await cleanupTempDir(fx.tempDir);
  });

  async function createActiveContract(title = 'Failable'): Promise<string> {
    return fx.manager.create(makeContractYaml({
      title,
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
  }

  it('commits active → archive/failed with audit + notification, never as cancelled', async () => {
    const contractId = await createActiveContract();

    const outcome = await fx.manager.fail(contractId as ContractId, FAILURE);

    expect(outcome).toMatchObject({ kind: 'committed', state: 'failed', requested: 'failed' });
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'archive', 'failed', contractId))).toBe(true);
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'active', contractId))).toBe(false);
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'archive', 'cancelled', contractId))).toBe(false);

    const failed = failedAuditCalls(fx);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual(expect.arrayContaining([
      expect.stringContaining(`contractId=${contractId}`),
      expect.stringContaining(`reason=${FAILURE.reason}`),
      expect.stringContaining(`evidence_ref=${FAILURE.evidenceRef}`),
      expect.stringContaining(`producer=${FAILURE.producer}`),
    ]));

    // cancel-is-not-failure reverse: no cancelled audit/notification.
    expect(cancelledAuditCalls(fx)).toHaveLength(0);
    expect(fx.notifies.filter(n => n.type === 'contract_cancelled')).toHaveLength(0);

    const failedNotifies = fx.notifies.filter(n => n.type === 'contract_failed');
    expect(failedNotifies).toHaveLength(1);
    expect(failedNotifies[0]).toMatchObject({
      contractId,
      reason: FAILURE.reason,
      evidenceRef: FAILURE.evidenceRef,
      producer: FAILURE.producer,
    });
  });

  it('is idempotent for the same request id: already_committed without duplicate side effects', async () => {
    const contractId = await createActiveContract();

    const first = await fx.manager.fail(contractId as ContractId, FAILURE, 'fail-req-1');
    const second = await fx.manager.fail(contractId as ContractId, FAILURE, 'fail-req-1');

    expect(first.kind).toBe('committed');
    expect(second).toMatchObject({ kind: 'already_committed', state: 'failed', requestId: 'fail-req-1' });
    expect(failedAuditCalls(fx)).toHaveLength(1);
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(1);
  });

  it('loses to an already-cancelled contract and reports the real winner without side effects', async () => {
    const contractId = await createActiveContract();
    await fx.manager.cancel(contractId as ContractId, 'user cancelled');

    const notifyCountBefore = fx.notifies.length;

    const outcome = await fx.manager.fail(contractId as ContractId, FAILURE);

    expect(outcome).toMatchObject({ kind: 'lost_to_state', requested: 'failed', committed: 'cancelled' });
    expect(failedAuditCalls(fx)).toHaveLength(0);
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(0);
    expect(fx.notifies.length).toBe(notifyCountBefore);
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'archive', 'cancelled', contractId))).toBe(true);
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'archive', 'failed', contractId))).toBe(false);
  });

  it('returns retryable_failure for a contract that does not exist', async () => {
    const outcome = await fx.manager.fail('missing-contract' as ContractId, FAILURE);
    expect(outcome.kind).toBe('retryable_failure');
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(0);
  });
});

describe('Phase 1396 Step D: boot reconcile replays failed intents', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await setup();
  });

  afterEach(async () => {
    await cleanupTempDir(fx.tempDir);
  });

  async function seedActiveContract(contractId: string, subtaskStatus: 'todo' | 'completed') {
    const activeRoot = path.join(fx.clawDir, 'contract', 'active', contractId);
    await fs.mkdir(activeRoot, { recursive: true });
    await fs.writeFile(
      path.join(activeRoot, 'contract.yaml'),
      [
        'schema_version: 1',
        `id: ${contractId}`,
        'title: Boot Failed',
        'goal: Test',
        'subtasks:',
        '  - id: t1',
        '    description: T1',
        '',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(activeRoot, 'progress.json'),
      JSON.stringify({
        schema_version: 1,
        subtasks: {
          t1: {
            status: subtaskStatus,
            ...(subtaskStatus === 'completed' ? { completed_at: new Date().toISOString() } : {}),
          },
        },
        started_at: new Date().toISOString(),
      }, null, 2),
    );
  }

  it('replays a persisted failed intent without the completed precondition (subtasks still todo)', async () => {
    const contractId = 'boot-failed-intent';
    await seedActiveContract(contractId, 'todo');
    const intent = buildFailedIntent(contractId as ContractId, 'fail-boot-1', FAILURE);
    await persistLifecycleIntent(new NodeFileSystem({ baseDir: fx.clawDir }), fx.audit, fx.clawDir, intent);

    await fx.manager.init();

    expect(await fileExists(path.join(fx.clawDir, 'contract', 'archive', 'failed', contractId))).toBe(true);
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'active', contractId))).toBe(false);
    expect(fx.auditWrite.mock.calls.some((c: any[]) =>
      c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE_INTENT_OUTCOME &&
      c.some((col: any) => String(col).includes('requestId=fail-boot-1')) &&
      c.some((col: any) => String(col).includes('outcome=committed')),
    )).toBe(true);
    // Boot reconcile performs no business side effects: no contract_failed notify.
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(0);
  });
});

describe('Phase 1396 Step D: ContractSystem.failActiveForExecutor', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await setup();
  });

  afterEach(async () => {
    await cleanupTempDir(fx.tempDir);
  });

  it('returns an empty outcome list when the executor has no active contract', async () => {
    const outcomes = await fx.manager.failActiveForExecutor({ executorId: EXECUTOR_ID, failure: FAILURE });
    expect(outcomes).toEqual([]);
  });

  it('fails every active contract of the executor in deterministic (sorted id) order', async () => {
    const idB = await fx.manager.create(makeContractYaml({
      title: 'B',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
    const idA = await fx.manager.create(makeContractYaml({
      title: 'A',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
    // Force deterministic ids independent of creation order.
    expect(idA).not.toBe(idB);
    const sorted = [idA, idB].sort();

    const outcomes = await fx.manager.failActiveForExecutor({ executorId: EXECUTOR_ID, failure: FAILURE });

    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ kind: 'committed', state: 'failed' });
    }
    // Deterministic enumeration: intents land in sorted contract-id order.
    const intentPersistedOrder = fx.auditWrite.mock.calls
      .filter((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_PERSISTED)
      .map((c: any[]) => String(c.find((col: any) => String(col).startsWith('contractId='))).slice('contractId='.length));
    expect(intentPersistedOrder).toEqual(sorted);

    for (const id of [idA, idB]) {
      expect(await fileExists(path.join(fx.clawDir, 'contract', 'archive', 'failed', id))).toBe(true);
    }
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(2);
  });

  it('refuses foreign executor ids without touching local contracts', async () => {
    const contractId = await fx.manager.create(makeContractYaml({
      title: 'Local',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const outcomes = await fx.manager.failActiveForExecutor({ executorId: 'other-executor', failure: FAILURE });

    expect(outcomes).toEqual([]);
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'active', contractId))).toBe(true);
    expect(fx.auditWrite.mock.calls.some((c: any[]) =>
      c[0] === CONTRACT_AUDIT_EVENTS.FAIL_EXECUTOR_MISMATCH,
    )).toBe(true);
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(0);
  });
});
