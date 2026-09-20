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

async function setup(overrides?: { makeFs?: (clawDir: string) => NodeFileSystem }): Promise<Fixture> {
  const tempDir = await createTempDir('phase1396-failed-');
  const clawDir = path.join(tempDir, 'claws', EXECUTOR_ID);
  await fs.mkdir(clawDir, { recursive: true });

  const notifies: ContractNotification[] = [];
  const auditWrite = vi.fn();
  const audit = { write: auditWrite, preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as any;
  const manager = new ContractSystem({
    clawDir,
    clawId: EXECUTOR_ID,
    fs: overrides?.makeFs ? overrides.makeFs(clawDir) : new NodeFileSystem({ baseDir: clawDir }),
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: path.join(tempDir, 'claws'),
    notifyClaw: () => Promise.resolve(),
    // phase 1872 Step F: onNotify 构造参数一次固定（setter 退役）
    onNotify: (event) => notifies.push(event),
  });

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

    expect(outcome).toMatchObject({ contractId, commit: { kind: 'committed', state: 'failed', requested: 'failed' } });
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

    expect(first.commit.kind).toBe('committed');
    expect(second).toMatchObject({ commit: { kind: 'already_committed', state: 'failed', requestId: 'fail-req-1' } });
    expect(failedAuditCalls(fx)).toHaveLength(1);
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(1);
  });

  it('loses to an already-cancelled contract and reports the real winner without side effects', async () => {
    const contractId = await createActiveContract();
    await fx.manager.cancel(contractId as ContractId, 'user cancelled');

    const notifyCountBefore = fx.notifies.length;

    const outcome = await fx.manager.fail(contractId as ContractId, FAILURE);

    expect(outcome).toMatchObject({ commit: { kind: 'lost_to_state', requested: 'failed', committed: 'cancelled' } });
    expect(failedAuditCalls(fx)).toHaveLength(0);
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(0);
    expect(fx.notifies.length).toBe(notifyCountBefore);
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'archive', 'cancelled', contractId))).toBe(true);
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'archive', 'failed', contractId))).toBe(false);
  });

  it('returns retryable_failure for a contract that does not exist', async () => {
    const outcome = await fx.manager.fail('missing-contract' as ContractId, FAILURE);
    expect(outcome.commit.kind).toBe('retryable_failure');
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

describe('Phase 1803 Step B: ContractSystem.failActiveForExecutor (typed ReportOutcome 收口)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await setup();
  });

  afterEach(async () => {
    await cleanupTempDir(fx.tempDir);
  });

  async function countIntentFiles(contractId: string): Promise<number> {
    const dir = path.join(fx.clawDir, 'contract', 'lifecycle-intents', contractId);
    if (!(await fileExists(dir))) return 0;
    return (await fs.readdir(dir)).filter(n => n.endsWith('.json')).length;
  }

  async function createActive(title: string): Promise<string> {
    return fx.manager.create(makeContractYaml({
      title,
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
  }

  it('returns committed when the executor has no active contract', async () => {
    await expect(
      fx.manager.failActiveForExecutor({ executorId: EXECUTOR_ID, failure: FAILURE }),
    ).resolves.toEqual({ kind: 'committed' });
  });

  it('fails every active contract of the executor in deterministic (sorted id) order', async () => {
    const idB = await createActive('B');
    const idA = await createActive('A');
    // Force deterministic ids independent of creation order.
    expect(idA).not.toBe(idB);
    const sorted = [idA, idB].sort();

    await expect(
      fx.manager.failActiveForExecutor({ executorId: EXECUTOR_ID, failure: FAILURE }),
    ).resolves.toEqual({ kind: 'committed' });

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

  it('derives a stable requestId per contract: reporting the same fact twice reuses one intent', async () => {
    const contractId = await createActive('Stable');
    const input = { executorId: EXECUTOR_ID, failure: FAILURE };

    await expect(fx.manager.failActiveForExecutor(input)).resolves.toEqual({ kind: 'committed' });
    // 重试：contract 已归档、不再枚举 → 不产生新 intent。
    await expect(fx.manager.failActiveForExecutor(input)).resolves.toEqual({ kind: 'committed' });

    expect(await countIntentFiles(contractId)).toBe(1);
    expect(failedAuditCalls(fx)).toHaveLength(1);
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(1);
  });

  it('returns retryable when the terminal rename is retryable, keeps the intent, and the retry closes the same intent', async () => {
    // 注入 moveDir 失败：rename 失败、contract 仍 active → retryable outcome。
    const failMoves = { current: true };
    class FlakyMoveFs extends NodeFileSystem {
      override async moveDir(fromPath: string, toPath: string): Promise<void> {
        if (failMoves.current && fromPath.includes(`active${path.sep}`)) {
          throw new Error('mock move failure');
        }
        return super.moveDir(fromPath, toPath);
      }
    }
    await cleanupTempDir(fx.tempDir);
    fx = await setup({ makeFs: (dir) => new FlakyMoveFs({ baseDir: dir }) });

    const contractId = await createActive('Retryable');
    const input = { executorId: EXECUTOR_ID, failure: FAILURE };

    const retryableOutcome = await fx.manager.failActiveForExecutor(input);
    expect(retryableOutcome.kind).toBe('retryable');
    expect((retryableOutcome as { error: string }).error).toContain('mock move failure');
    // intent 已持久化（at-least-once 证据在 ContractSystem 侧），contract 仍 active。
    expect(await countIntentFiles(contractId)).toBe(1);
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'active', contractId))).toBe(true);
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(0);

    // 重试同一失败事实：稳定 requestId 复用同一 intent，成功闭合后 committed。
    failMoves.current = false;
    await expect(fx.manager.failActiveForExecutor(input)).resolves.toEqual({ kind: 'committed' });
    expect(await countIntentFiles(contractId)).toBe(1);
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'archive', 'failed', contractId))).toBe(true);
  });

  it('processes remaining active contracts when an earlier one is retryable; retry only touches still-active contracts', async () => {
    const failMoves = { current: true };
    class PartialMoveFs extends NodeFileSystem {
      failFor = '';
      override async moveDir(fromPath: string, toPath: string): Promise<void> {
        if (failMoves.current && this.failFor !== '' && fromPath.includes(`active${path.sep}${this.failFor}`)) {
          throw new Error('mock move failure');
        }
        return super.moveDir(fromPath, toPath);
      }
    }
    let partial!: PartialMoveFs;
    await cleanupTempDir(fx.tempDir);
    fx = await setup({ makeFs: (dir) => { partial = new PartialMoveFs({ baseDir: dir }); return partial; } });

    const id1 = await createActive('One');
    const id2 = await createActive('Two');
    const sorted = [id1, id2].sort();
    partial.failFor = sorted[0];

    // 第一个（sorted 序）retryable：retryable outcome，但第二个仍被处理并归档。
    await expect(
      fx.manager.failActiveForExecutor({ executorId: EXECUTOR_ID, failure: FAILURE }),
    ).resolves.toMatchObject({ kind: 'retryable' });
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'active', sorted[0]))).toBe(true);
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'archive', 'failed', sorted[1]))).toBe(true);
    expect(await countIntentFiles(sorted[0])).toBe(1);
    expect(await countIntentFiles(sorted[1])).toBe(1);

    // 重试：只枚举仍 active 的 contract；已归档的不产生新 intent。
    failMoves.current = false;
    await expect(
      fx.manager.failActiveForExecutor({ executorId: EXECUTOR_ID, failure: FAILURE }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'archive', 'failed', sorted[0]))).toBe(true);
    expect(await countIntentFiles(sorted[0])).toBe(1);
    expect(await countIntentFiles(sorted[1])).toBe(1);
    expect(failedAuditCalls(fx)).toHaveLength(2);
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(2);
  });

  it('returns rejected for foreign executor ids without touching local contracts', async () => {
    const contractId = await createActive('Local');

    const outcome = await fx.manager.failActiveForExecutor({ executorId: 'other-executor', failure: FAILURE });
    expect(outcome.kind).toBe('rejected');
    expect((outcome as { reason: string }).reason).toContain('other-executor');
    expect(await fileExists(path.join(fx.clawDir, 'contract', 'active', contractId))).toBe(true);
    expect(fx.auditWrite.mock.calls.some((c: any[]) =>
      c[0] === CONTRACT_AUDIT_EVENTS.FAIL_EXECUTOR_MISMATCH,
    )).toBe(true);
    expect(fx.notifies.filter(n => n.type === 'contract_failed')).toHaveLength(0);
  });
});
