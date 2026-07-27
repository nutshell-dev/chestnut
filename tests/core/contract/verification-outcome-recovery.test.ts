/**
 * Phase 1201 Step C: boot replay of durable verification outcomes.
 *
 * 覆盖反向验收：
 * ① persist 后 apply 前崩溃 → boot 恢复 pass/reject
 * ② replay 先于 in_progress reset
 * ③ duplicate boot 不重复 mutation/side effects
 * ④ 旧 attempt outcome 不覆盖新 attempt（superseded）
 * ⑤ malformed/mismatch fail-closed 保留 + audit（store 层测试外的 boot 集成）
 * ⑥ terminal contract outcome 不写 archive progress（not_active）
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { buildVerificationOutcome } from '../../../src/core/contract/verification-outcome.js';
import { makeContractId, makeSubtaskId } from '../../../src/core/contract/types.js';

const cleanups: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanupTempDir(cleanups.pop()!);
});

let clawDir: string;
let nodeFs: NodeFileSystem;

async function setup() {
  const tempDir = await createTempDir('phase1201-recovery-');
  cleanups.push(tempDir);
  clawDir = path.join(tempDir, 'claws', 'test-claw');
  await fsp.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
  return { tempDir, clawDir };
}

function makeManager(audit: any) {
  return new ContractSystem({
    clawDir,
    clawId: 'test-claw',
    fs: nodeFs,
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),
  });
}

const CONTRACT_ID = 'c-boot';

/** 两 subtask 的 active contract；st1 状态由参数定，st2 永远 todo（避免 all-completed archive）。 */
async function seedActiveContract(st1: Record<string, unknown>) {
  const activeRoot = path.join(clawDir, 'contract', 'active', CONTRACT_ID);
  await fsp.mkdir(activeRoot, { recursive: true });
  await fsp.writeFile(
    path.join(activeRoot, 'contract.yaml'),
    [
      'schema_version: 1',
      `id: ${CONTRACT_ID}`,
      'title: Boot Replay',
      'goal: Test',
      'subtasks:',
      '  - id: st1',
      '    description: S1',
      '  - id: st2',
      '    description: S2',
      '',
    ].join('\n'),
  );
  await fsp.writeFile(
    path.join(activeRoot, 'progress.json'),
    JSON.stringify(
      {
        schema_version: 1,
        subtasks: { st1, st2: { status: 'todo' } },
        started_at: '2026-07-27T00:00:00.000Z',
      },
      null,
      2,
    ),
  );
}

async function writeOutcomeFile(attemptId: string, payload: unknown) {
  const dir = path.join(clawDir, 'contract', 'verification-outcomes', CONTRACT_ID);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${attemptId}.json`), JSON.stringify(payload, null, 2));
}

async function readSt1() {
  const progress = JSON.parse(
    await fsp.readFile(path.join(clawDir, 'contract', 'active', CONTRACT_ID, 'progress.json'), 'utf-8'),
  );
  return progress.subtasks.st1;
}

function outcomeFilePath(attemptId: string) {
  return path.join(clawDir, 'contract', 'verification-outcomes', CONTRACT_ID, `${attemptId}.json`);
}

const IDENTITY = {
  contractId: makeContractId(CONTRACT_ID),
  subtaskId: makeSubtaskId('st1'),
  attemptId: 'att-1',
  completedAt: '2026-07-27T01:00:00.000Z',
};

function replayEvents(events: any[][]) {
  return events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_REPLAY);
}

describe('boot replay of durable verification outcomes (phase 1201 step C)', () => {
  it('① crash after persist before apply (passed) → boot replays to completed, outcome file retained', async () => {
    await setup();
    await seedActiveContract({ status: 'in_progress', verification_attempt_id: 'att-1' });
    await writeOutcomeFile('att-1', buildVerificationOutcome(IDENTITY, {
      kind: 'passed',
      result: { passed: true, feedback: 'lgtm' },
    }));

    const { audit, events } = makeAudit();
    await makeManager(audit).init();

    const st1 = await readSt1();
    expect(st1.status).toBe('completed');
    expect(st1.completed_at).toBe('2026-07-27T01:00:00.000Z');

    const replay = replayEvents(events);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toContainEqual('result=replayed');
    expect(replay[0]).toContainEqual('outcome_kind=passed');

    // durable fact 不随 apply 删除。
    await fsp.access(outcomeFilePath('att-1'));
    // 该 subtask 不再被 boot reset。
    expect(events.some(e =>
      e[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_IN_PROGRESS_RESET
      && e.some((c: any) => String(c).includes('subtask=st1')),
    )).toBe(false);
  });

  it('① crash after persist before apply (rejected) → boot replays to todo + retry_count + feedback', async () => {
    await setup();
    await seedActiveContract({ status: 'in_progress', verification_attempt_id: 'att-1' });
    await writeOutcomeFile('att-1', buildVerificationOutcome(IDENTITY, {
      kind: 'rejected',
      result: { passed: false, feedback: 'not good enough' },
      cause: 'llm_rejected',
      maxAttempts: 3,
    }));

    const { audit, events } = makeAudit();
    await makeManager(audit).init();

    const st1 = await readSt1();
    expect(st1.status).toBe('todo');
    expect(st1.retry_count).toBe(1);
    expect(st1.last_failed_feedback).toEqual({ feedback: 'not good enough', cause: 'llm_rejected' });

    const replay = replayEvents(events);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toContainEqual('result=replayed');
  });

  it('① rejected outcome 达 max_attempts → boot replay force-accept 完成', async () => {
    await setup();
    await seedActiveContract({ status: 'in_progress', verification_attempt_id: 'att-1' });
    await writeOutcomeFile('att-1', buildVerificationOutcome(IDENTITY, {
      kind: 'rejected',
      result: { passed: false, feedback: 'still bad' },
      cause: 'llm_rejected',
      maxAttempts: 1,
    }));

    const { audit, events } = makeAudit();
    await makeManager(audit).init();

    const st1 = await readSt1();
    expect(st1.status).toBe('completed');
    expect(st1.force_accepted).toBe(true);
    expect(st1.retry_count).toBe(1);
    expect(replayEvents(events)[0]).toContainEqual('result=replayed');
  });

  it('② replay 先于 in_progress reset：有 outcome 的 replay，无 outcome 的 reset，audit 顺序固定', async () => {
    await setup();
    await seedActiveContract({ status: 'in_progress', verification_attempt_id: 'att-1' });
    // st2 也是遗留 in_progress 但没有 durable outcome → 必须走 reset。
    const progressPath = path.join(clawDir, 'contract', 'active', CONTRACT_ID, 'progress.json');
    const seeded = JSON.parse(await fsp.readFile(progressPath, 'utf-8'));
    seeded.subtasks.st2 = { status: 'in_progress', verification_attempt_id: 'att-orphan' };
    await fsp.writeFile(progressPath, JSON.stringify(seeded, null, 2));
    await writeOutcomeFile('att-1', buildVerificationOutcome(IDENTITY, {
      kind: 'passed',
      result: { passed: true, feedback: 'ok' },
    }));

    const { audit, events } = makeAudit();
    await makeManager(audit).init();

    const progress = JSON.parse(await fsp.readFile(progressPath, 'utf-8'));
    expect(progress.subtasks.st1.status).toBe('completed');
    expect(progress.subtasks.st2.status).toBe('todo');
    expect(progress.subtasks.st2.verification_attempt_id).toBeUndefined();

    const replayIdx = events.findIndex(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_REPLAY);
    const resetIdx = events.findIndex(e => e[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_IN_PROGRESS_RESET);
    expect(replayIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(replayIdx);
    // reset 只作用于 st2。
    const resets = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_IN_PROGRESS_RESET);
    expect(resets).toHaveLength(1);
    expect(resets[0]).toContainEqual('subtask=st2');
  });

  it('③ duplicate boot：第二次 init 分类 already_applied，不重复 mutation、progress 不变', async () => {
    await setup();
    await seedActiveContract({ status: 'in_progress', verification_attempt_id: 'att-1' });
    await writeOutcomeFile('att-1', buildVerificationOutcome(IDENTITY, {
      kind: 'rejected',
      result: { passed: false, feedback: 'bad' },
      cause: 'llm_rejected',
      maxAttempts: 3,
    }));

    const first = makeAudit();
    await makeManager(first.audit).init();
    const afterFirst = await fsp.readFile(
      path.join(clawDir, 'contract', 'active', CONTRACT_ID, 'progress.json'), 'utf-8',
    );
    expect(replayEvents(first.events)[0]).toContainEqual('result=replayed');

    // 模拟进程重启：新 manager 实例、新 audit。
    const second = makeAudit();
    await makeManager(second.audit).init();
    const afterSecond = await fsp.readFile(
      path.join(clawDir, 'contract', 'active', CONTRACT_ID, 'progress.json'), 'utf-8',
    );

    expect(afterSecond).toBe(afterFirst);
    const replay = replayEvents(second.events);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toContainEqual('result=already_applied');
    // 第二次 boot 无 reset（第一次已落地终态）。
    expect(second.events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_IN_PROGRESS_RESET)).toBe(false);
  });

  it('④ 旧 attempt outcome 不覆盖新 attempt：superseded + 遗留 attempt 由 reset 处理 + durable fact 保留', async () => {
    await setup();
    await seedActiveContract({ status: 'in_progress', verification_attempt_id: 'att-new' });
    await writeOutcomeFile('att-old', buildVerificationOutcome(
      { ...IDENTITY, attemptId: 'att-old' },
      { kind: 'passed', result: { passed: true, feedback: 'old pass' } },
    ));

    const { audit, events } = makeAudit();
    await makeManager(audit).init();

    const replay = replayEvents(events);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toContainEqual('result=superseded');
    expect(replay[0]).toContainEqual('attemptId=att-old');

    // 旧 outcome 未应用；遗留 in_progress（att-new）被 reset 为 todo。
    const st1 = await readSt1();
    expect(st1.status).toBe('todo');
    expect(st1.completed_at).toBeUndefined();
    expect(st1.verification_attempt_id).toBeUndefined();

    // durable fact 保留供 forensics。
    await fsp.access(outcomeFilePath('att-old'));
  });

  it('⑤ boot 集成：malformed outcome fail-closed 保留 + audit issue，合法 outcome 照常 replay', async () => {
    await setup();
    await seedActiveContract({ status: 'in_progress', verification_attempt_id: 'att-1' });
    await writeOutcomeFile('att-1', buildVerificationOutcome(IDENTITY, {
      kind: 'passed',
      result: { passed: true, feedback: 'ok' },
    }));
    const dir = path.join(clawDir, 'contract', 'verification-outcomes', CONTRACT_ID);
    await fsp.writeFile(path.join(dir, 'att-bad.json'), '{corrupted', 'utf-8');

    const { audit, events } = makeAudit();
    await makeManager(audit).init();

    expect((await readSt1()).status).toBe('completed');
    const issues = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_READ_ISSUE);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContainEqual('attemptId=att-bad');
    expect(issues[0]).toContainEqual('reason=parse_failed');
    // malformed 文件保留。
    await fsp.access(path.join(dir, 'att-bad.json'));
  });

  it('⑥ contract 已 terminal（无 active）：replay 分类 not_active，不写任何 progress', async () => {
    await setup();
    // 只写 outcome，不 seed active contract。
    await writeOutcomeFile('att-1', buildVerificationOutcome(IDENTITY, {
      kind: 'passed',
      result: { passed: true, feedback: 'ok' },
    }));
    // archive 里有一份 terminal progress（不应被 outcome 触碰）。
    const archiveRoot = path.join(clawDir, 'contract', 'archive', 'completed', CONTRACT_ID);
    await fsp.mkdir(archiveRoot, { recursive: true });
    const archiveProgress = JSON.stringify({
      schema_version: 1,
      subtasks: { st1: { status: 'completed', completed_at: '2026-07-26T00:00:00.000Z' } },
      started_at: '2026-07-26T00:00:00.000Z',
    });
    await fsp.writeFile(path.join(archiveRoot, 'progress.json'), archiveProgress);

    const { audit, events } = makeAudit();
    await makeManager(audit).init();

    // archive progress 未被写。
    expect(await fsp.readFile(path.join(archiveRoot, 'progress.json'), 'utf-8')).toBe(archiveProgress);
    // 没有任何 replay applied 类事件指向 archive（not_active 时 replay mutation 只在 active 缺失时
    // 分类——boot 遍历 active 列表，本例无 active entry，因此连 replay 都不发生）。
    expect(replayEvents(events).filter(e => e.includes('result=replayed'))).toHaveLength(0);
  });
});
