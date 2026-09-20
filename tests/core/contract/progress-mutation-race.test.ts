/**
 * Phase 1201 Step B: queued fresh-read progress transition races.
 *
 * Deterministic barriers (deferred promises + audit events), no sleep.
 * Reverse acceptance:
 * 1. 同 Contract 两个不同 subtask 同步完成均保留（无 lost update）。
 * 2. 同 subtask 双 submit 只有一个更新。
 * 3. start 与 sync complete 竞争按 FIFO 看到前一提交。
 * 4. queue 执行期间 contract 被 cancel，mutation 不写 archive progress。
 * 5. post-commit notify 抛错不回滚 progress，也不毒死 queue。
 * 6. (Step D) async start/async start 同 subtask：无内存闸门，queued fresh-read
 *    status 规则拒绝第二 start。
 * 7. (Step D) async outcome/sync submit：FIFO 无 lost update，迟到者不覆盖。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { completeSubtask } from '../../helpers/contract-subtask.js';
import { makeAudit, waitForNextAuditEvent } from '../../helpers/audit.js';
import { makeContractId, makeSubtaskId } from '../../../src/core/contract/types.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

interface Fixture {
  tempDir: string;
  clawDir: string;
  fs: FileSystem;
  manager: ContractSystem;
  auditEvents: Array<[string, ...(string | number)[]]>;
  auditEmitter: ReturnType<typeof makeAudit>['emitter'];
}

// phase 1872 Step F: onNotify 构造参数一次固定（setter 退役）
async function setup(overrides?: { onNotify?: (event: ContractNotification) => void }): Promise<Fixture> {
  const tempDir = await createTempDir('phase1201-race-');
  const clawDir = path.join(tempDir, 'claws', 'race-claw');
  await fsp.mkdir(clawDir, { recursive: true });
  const { audit, events, emitter } = makeAudit();
  const fs = new NodeFileSystem({ baseDir: clawDir });
  const manager = new ContractSystem({
    clawDir,
    clawId: 'race-claw',
    fs,
    audit,
    notifyClaw: () => {},
    toolRegistry: createToolRegistry(),
    fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    ...(overrides?.onNotify ? { onNotify: overrides.onNotify } : {}),
  });
  return { tempDir, clawDir, fs, manager, auditEvents: events, auditEmitter: emitter };
}

/**
 * Gate the FIRST read of the active progress.json so the first queued mutation
 * pauses mid-RMW until released (proves the second mutation cannot interleave).
 */
function gateFirstActiveProgressRead(fs: FileSystem, gate: { promise: Promise<void> }): void {
  const mutable = fs as { read: (p: string) => Promise<string> };
  const origRead = mutable.read.bind(fs);
  let armed = true;
  mutable.read = async (p: string) => {
    if (armed && p.includes('contract/active/') && p.endsWith('progress.json')) {
      armed = false;
      await gate.promise;
    }
    return origRead(p);
  };
}

async function readActiveProgress(clawDir: string, contractId: string): Promise<any> {
  const raw = await fsp.readFile(path.join(clawDir, 'contract', 'active', contractId, 'progress.json'), 'utf-8');
  return JSON.parse(raw);
}

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop()!;
    await cleanupTempDir(dir);
  }
});

/** 等待 PROGRESS_MUTATION_QUEUED 事件累计达到 n 次（fast-path 已发生的事件）。 */
async function waitForQueuedCount(
  events: Array<[string, ...(string | number)[]]>,
  emitter: ReturnType<typeof makeAudit>['emitter'],
  n: number,
): Promise<void> {
  const count = () => events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_QUEUED).length;
  while (count() < n) {
    await waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_QUEUED);
  }
}

describe('progress mutation race (phase 1201 step B)', () => {
  it('sync/sync 不同 subtask：两项完成均保留，无 lost update', async () => {
    const fx = await setup();
    cleanups.push(fx.tempDir);
    const contractId = await fx.manager.create(makeContractYaml({
      subtasks: [
        { id: 'st1', description: 'S1' },
        { id: 'st2', description: 'S2' },
      ],
      verification: [],
    }));

    const gate = deferred();
    gateFirstActiveProgressRead(fx.fs, gate);

    const p1 = completeSubtask(fx.manager, {
      contractId: makeContractId(contractId),
      subtaskId: makeSubtaskId('st1'),
      evidence: 'e1',
    });
    const p2 = completeSubtask(fx.manager, {
      contractId: makeContractId(contractId),
      subtaskId: makeSubtaskId('st2'),
      evidence: 'e2',
    });

    // 等两个 mutation 都入队后再放行第一个的 read。
    await waitForQueuedCount(fx.auditEvents, fx.auditEmitter, 2);
    gate.resolve();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.passed).toBe(true);
    expect(r2.passed).toBe(true);

    // 全部完成 → 已归档；archive progress 两项均 completed。
    const archiveProgress = JSON.parse(await fsp.readFile(
      path.join(fx.clawDir, 'contract', 'archive', 'completed', contractId, 'progress.json'),
      'utf-8',
    ));
    expect(archiveProgress.subtasks.st1.status).toBe('completed');
    expect(archiveProgress.subtasks.st2.status).toBe('completed');
    expect(archiveProgress.subtasks.st1.evidence).toBe('e1');
    expect(archiveProgress.subtasks.st2.evidence).toBe('e2');
  });

  it('同 subtask 双 submit：FIFO fresh-read 后只有一个完成，另一个看到 already completed', async () => {
    const fx = await setup();
    cleanups.push(fx.tempDir);
    const contractId = await fx.manager.create(makeContractYaml({
      subtasks: [{ id: 'st1', description: 'S1' }],
      verification: [],
    }));

    const gate = deferred();
    gateFirstActiveProgressRead(fx.fs, gate);

    const submit = () => completeSubtask(fx.manager, {
      contractId: makeContractId(contractId),
      subtaskId: makeSubtaskId('st1'),
      evidence: 'e',
    });
    const p1 = submit();
    const p2 = submit();

    await waitForQueuedCount(fx.auditEvents, fx.auditEmitter, 2);
    gate.resolve();

    const [r1, r2] = await Promise.all([p1, p2]);
    const results = [r1, r2];
    expect(results.filter(r => r.passed)).toHaveLength(1);
    expect(results.filter(r => !r.passed && r.feedback.includes('already completed'))).toHaveLength(1);

    // allCompleted → archived；只写一次 completion。
    const completedAudits = fx.auditEvents.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED);
    expect(completedAudits).toHaveLength(1);
  });

  it('attempt start 与 sync completion 竞争：FIFO 看到前一提交（start 先 → sync duplicate）', async () => {
    const fx = await setup();
    cleanups.push(fx.tempDir);
    const contractId = makeContractId(await fx.manager.create(makeContractYaml({
      subtasks: [{ id: 'st1', description: 'S1' }],
      verification: [],
    })));
    const st1 = makeSubtaskId('st1');

    const gate = deferred();
    gateFirstActiveProgressRead(fx.fs, gate);

    const pStart = fx.manager.transitionVerificationAttempt(contractId, st1, {
      kind: 'start',
      attemptId: 'att-1',
      evidence: 'e',
      artifacts: [],
      at: new Date().toISOString(),
    });
    const pSync = fx.manager._submitSyncCompletion(contractId, st1, {
      evidence: 'e2',
      at: new Date().toISOString(),
    });

    await waitForQueuedCount(fx.auditEvents, fx.auditEmitter, 2);
    gate.resolve();

    const [startResult, syncResult] = await Promise.all([pStart, pSync]);
    expect(startResult.kind).toBe('updated');
    // sync completion 在 queue 内 fresh-read，看到 start 已提交的 in_progress → duplicate。
    expect(syncResult.kind).toBe('duplicate');

    const progress = await readActiveProgress(fx.clawDir, contractId);
    expect(progress.subtasks.st1.status).toBe('in_progress');
    expect(progress.subtasks.st1.verification_attempt_id).toBe('att-1');
  });

  it('queue 执行期间 contract 被 cancel：mutation fail-closed，不写 archive progress', async () => {
    const fx = await setup();
    cleanups.push(fx.tempDir);
    const contractId = makeContractId(await fx.manager.create(makeContractYaml({
      subtasks: [{ id: 'st1', description: 'S1' }],
      verification: [],
    })));
    const st1 = makeSubtaskId('st1');

    // Gate 第一个 queued mutation 的 progress read；read 被阻塞期间 cancel。
    const gate = deferred();
    const mutable = fx.fs as { read: (p: string) => Promise<string> };
    const origRead = mutable.read.bind(fx.fs);
    let armed = true;
    const readEntered = deferred();
    mutable.read = async (p: string) => {
      if (armed && p.includes('contract/active/') && p.endsWith('progress.json')) {
        armed = false;
        readEntered.resolve();
        await gate.promise;
      }
      return origRead(p);
    };

    const pSync = fx.manager._submitSyncCompletion(contractId, st1, {
      evidence: 'e',
      at: new Date().toISOString(),
    });

    await readEntered.promise;
    // mutation 已 fresh-read 阻塞中；此时 cancel 赢 rename。
    const cancelOutcome = await fx.manager.cancel(contractId, 'race cancel');
    expect(cancelOutcome.commit.kind).toBe('committed');
    gate.resolve();

    const syncResult = await pSync;
    expect(syncResult.kind).toBe('not_active');

    // archive progress 未被迟到 mutation 改写。
    const archiveProgress = JSON.parse(await fsp.readFile(
      path.join(fx.clawDir, 'contract', 'archive', 'cancelled', contractId, 'progress.json'),
      'utf-8',
    ));
    expect(archiveProgress.subtasks.st1.status).toBe('todo');

    // active 目录未被重建。
    await expect(fsp.access(path.join(fx.clawDir, 'contract', 'active', contractId))).rejects.toThrow();
  });

  it('async start/async start 同 subtask：queued fresh-read 拒绝第二 start（Step D 无内存闸门）', async () => {
    const fx = await setup();
    cleanups.push(fx.tempDir);
    const contractId = makeContractId(await fx.manager.create(makeContractYaml({
      subtasks: [{ id: 'st1', description: 'S1' }],
      verification: [],
    })));
    const st1 = makeSubtaskId('st1');

    const gate = deferred();
    gateFirstActiveProgressRead(fx.fs, gate);

    const start = (attemptId: string) => fx.manager.transitionVerificationAttempt(contractId, st1, {
      kind: 'start',
      attemptId,
      evidence: 'e',
      artifacts: [],
      at: new Date().toISOString(),
    });
    const p1 = start('att-1');
    const p2 = start('att-2');

    await waitForQueuedCount(fx.auditEvents, fx.auditEmitter, 2);
    gate.resolve();

    const [r1, r2] = await Promise.all([p1, p2]);
    // FIFO：第一 start 提交 in_progress(att-1)；第二 start fresh-read 见非 todo → skipped。
    expect(r1.kind).toBe('updated');
    expect(r2.kind).toBe('skipped');

    const progress = await readActiveProgress(fx.clawDir, contractId);
    expect(progress.subtasks.st1.status).toBe('in_progress');
    expect(progress.subtasks.st1.verification_attempt_id).toBe('att-1');
  });

  it('async outcome/sync submit：FIFO 无 lost update，迟到者见已提交状态', async () => {
    const fx = await setup();
    cleanups.push(fx.tempDir);
    const contractId = makeContractId(await fx.manager.create(makeContractYaml({
      subtasks: [{ id: 'st1', description: 'S1' }],
      verification: [],
    })));
    const st1 = makeSubtaskId('st1');

    // 先落 in_progress(att-1)。
    const started = await fx.manager.transitionVerificationAttempt(contractId, st1, {
      kind: 'start',
      attemptId: 'att-1',
      evidence: 'e',
      artifacts: [],
      at: new Date().toISOString(),
    });
    expect(started.kind).toBe('updated');

    const gate = deferred();
    gateFirstActiveProgressRead(fx.fs, gate);

    const passAt = '2026-07-27T02:00:00.000Z';
    const pOutcome = fx.manager.transitionVerificationAttempt(contractId, st1, {
      kind: 'pass',
      attemptId: 'att-1',
      at: passAt,
    });
    const pSync = fx.manager._submitSyncCompletion(contractId, st1, {
      evidence: 'e-sync',
      at: new Date().toISOString(),
    });

    await waitForQueuedCount(fx.auditEvents, fx.auditEmitter, 3);
    gate.resolve();

    const [outcomeResult, syncResult] = await Promise.all([pOutcome, pSync]);
    expect(outcomeResult.kind).toBe('updated');
    // sync completion fresh-read 见 pass 已提交的 completed → already_completed，不覆盖。
    expect(syncResult.kind).toBe('already_completed');

    const progress = await readActiveProgress(fx.clawDir, contractId);
    expect(progress.subtasks.st1.status).toBe('completed');
    expect(progress.subtasks.st1.completed_at).toBe(passAt);
    expect(progress.subtasks.st1.evidence).not.toBe('e-sync');
  });

  it('active recheck 后 terminal rename 胜出：existing-parent write 0 ghost、archive bytes 不变（Step E）', async () => {
    const fx = await setup();
    cleanups.push(fx.tempDir);
    const contractId = makeContractId(await fx.manager.create(makeContractYaml({
      subtasks: [{ id: 'st1', description: 'S1' }],
      verification: [],
    })));
    const otherId = makeContractId(await fx.manager.create(makeContractYaml({
      subtasks: [{ id: 'st1', description: 'S1' }],
      verification: [],
    })));
    const st1 = makeSubtaskId('st1');

    // Barrier：queued mutation fresh-read + active recheck 通过后，暂停在
    // writeAtomicExisting 入口（temp-file 创建前），此时 cancel 赢 rename。
    const gate = deferred();
    const writeEntered = deferred();
    const mutable = fx.fs as { writeAtomicExisting: (p: string, c: string) => Promise<void> };
    const origWrite = mutable.writeAtomicExisting.bind(fx.fs);
    let armed = true;
    mutable.writeAtomicExisting = async (p: string, c: string) => {
      if (armed && p.includes(`contract/active/${contractId}/`)) {
        armed = false;
        writeEntered.resolve();
        await gate.promise;
      }
      return origWrite(p, c);
    };

    const pSync = fx.manager._submitSyncCompletion(contractId, st1, {
      evidence: 'loser-evidence',
      at: new Date().toISOString(),
    });
    await writeEntered.promise;

    // recheck 已过、物理写暂停 → terminal rename 胜出。
    const cancelOutcome = await fx.manager.cancel(contractId, 'step-E ghost race');
    expect(cancelOutcome.commit.kind).toBe('committed');
    gate.resolve();

    const syncResult = await pSync;
    // typed 分类：绝不报告 updated/completed。
    expect(syncResult.kind).toBe('not_active');

    // 0 ghost：active/<id> 不存在，且未被 write 复活。
    await expect(fsp.access(path.join(fx.clawDir, 'contract', 'active', contractId))).rejects.toThrow();
    // 只有 archive/cancelled 一个 terminal 目录。
    await expect(fsp.access(path.join(fx.clawDir, 'contract', 'archive', 'cancelled', contractId))).resolves.toBeUndefined();
    await expect(fsp.access(path.join(fx.clawDir, 'contract', 'archive', 'completed', contractId))).rejects.toThrow();
    // archive progress bytes 不含 loser mutation。
    const archiveProgress = JSON.parse(await fsp.readFile(
      path.join(fx.clawDir, 'contract', 'archive', 'cancelled', contractId, 'progress.json'),
      'utf-8',
    ));
    expect(archiveProgress.subtasks.st1.status).toBe('todo');
    expect(archiveProgress.subtasks.st1.evidence).toBeUndefined();
    // active 父目录下无 temp ghost。
    const activeEntries = await fsp.readdir(path.join(fx.clawDir, 'contract', 'active'));
    expect(activeEntries.filter(e => e.startsWith('.tmp_'))).toEqual([]);

    // queue 继续可用：另一 contract 的 mutation 正常完成。
    const other = await fx.manager._submitSyncCompletion(otherId, st1, {
      evidence: 'ok',
      at: new Date().toISOString(),
    });
    expect(other.kind).toBe('completed');
  });

  it('existing-parent write 胜出后 terminal rename：archive 含完整新 bytes（Step E）', async () => {
    const fx = await setup();
    cleanups.push(fx.tempDir);
    const contractId = makeContractId(await fx.manager.create(makeContractYaml({
      subtasks: [{ id: 'st1', description: 'S1' }],
      verification: [],
    })));
    const st1 = makeSubtaskId('st1');

    // file commit 先完成。
    const sync = await fx.manager._submitSyncCompletion(contractId, st1, {
      evidence: 'winner-evidence',
      at: new Date().toISOString(),
    });
    expect(sync.kind).toBe('completed');

    // terminal rename 随后发生：新 progress 一并提交到 archive，无半写。
    const cancelOutcome = await fx.manager.cancel(contractId, 'after commit');
    expect(cancelOutcome.commit.kind).toBe('committed');

    const archiveProgress = JSON.parse(await fsp.readFile(
      path.join(fx.clawDir, 'contract', 'archive', 'cancelled', contractId, 'progress.json'),
      'utf-8',
    ));
    expect(archiveProgress.subtasks.st1.status).toBe('completed');
    expect(archiveProgress.subtasks.st1.evidence).toBe('winner-evidence');
    await expect(fsp.access(path.join(fx.clawDir, 'contract', 'active', contractId))).rejects.toThrow();
  });

  it('post-commit notify 抛错：progress 不回滚，queue 不毒化', async () => {
    const fx = await setup({ onNotify: () => {
      throw new Error('notify exploded');
    } });
    cleanups.push(fx.tempDir);
    const contractId = await fx.manager.create(makeContractYaml({
      subtasks: [
        { id: 'st1', description: 'S1' },
        { id: 'st2', description: 'S2' },
      ],
      verification: [],
    }));

    const r1 = await completeSubtask(fx.manager, {
      contractId: makeContractId(contractId),
      subtaskId: makeSubtaskId('st1'),
      evidence: 'e1',
    });
    expect(r1.passed).toBe(true);

    const notifyFailures = fx.auditEvents.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED);
    expect(notifyFailures.length).toBeGreaterThanOrEqual(1);

    // progress 已提交且后续 mutation 照常执行。
    const progress = await readActiveProgress(fx.clawDir, contractId);
    expect(progress.subtasks.st1.status).toBe('completed');

    const r2 = await completeSubtask(fx.manager, {
      contractId: makeContractId(contractId),
      subtaskId: makeSubtaskId('st2'),
      evidence: 'e2',
    });
    // queue 未毒化：后续 mutation 正常完成（r2 passed 即证明 queue 恢复可用）。
    expect(r2.passed).toBe(true);
  });
});
