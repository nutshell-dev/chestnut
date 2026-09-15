/**
 * Phase 1828：inbox 系统文案「迁移前 golden vs 迁移后入口输出」逐字节等价测试。
 *
 * fixture（tests/templates/messages/__fixtures__/inbox-text-golden.json）由迁移前的
 * 捕获器（development log/phase1828-logs/B-capture-golden.test.ts.txt）从旧实现的
 * 真实发送/呈现入口生成一次后固化；本测试用同一批入口与参数重跑，断言 body 与
 * envelope 逐字节相同。禁止用新模板反向生成 expected，禁止更新 fixture 掩盖变化。
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fsNative from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { EventLoop } from '../../../src/core/event-loop/index.js';
import { createStartupCheckDelivery } from '../../../src/daemon/daemon-loop.js';
import { createContractNotificationAdapter } from '../../../src/assembly/contract-notification-adapter.js';
import { scanArchivedContracts } from '../../../src/core/contract/jobs/event-collector.js';
import { lifecycleIntentPath } from '../../../src/core/contract/lifecycle-intent.js';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import { createHeartbeatInboxFormatter } from '../../../src/core/heartbeat/inbox-formatter.js';
import { runRandomDream } from '../../../src/core/memory/random-dream.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';
import { createClawTopology, MOTION_CLAW_ID } from '../../../src/core/claw-topology/index.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import type { AsyncTaskSystem as AsyncTaskSystemType } from '../../../src/core/async-task-system/system.js';
import { renderStandardInboxMessage } from '../../../src/foundation/messaging/formatter-registry.js';
import { SYSTEM_MESSAGE_PREFIX } from '../../../src/foundation/messaging/system-message-helper.js';
import { composer as overflowComposer } from '../../../src/assembly/guidance/composers/task-queue-overflow.js';
import { renderCliGuidanceDocument, createCliSafeToken } from '../../../src/cli-protocol/guidance.js';
import type { CliGuidanceDocument } from '../../../src/cli-protocol/guidance.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, '__fixtures__', 'inbox-text-golden.json');
const fixture = JSON.parse(fsNative.readFileSync(FIXTURE_PATH, 'utf8')) as {
  cases: Record<string, Case[]>;
};
const asserted = new Set<string>();

/**
 * phase 1829: M03 从逐字节迁移等价移交新的语义验收（通知正文携带身份与已提交处置、
 * 上游系统反馈归位模板）。phase 1830: M06 同样移交新语义验收（审阅反馈正文自含身份/
 * 来源/依据/可选建议，无依据结果不投递）。phase 1834: M07 语义治理（观察范围与读取
 * 消费副作用说明、历史重复只陈述事实、退役自动 skip 建议链），整组移交
 * tests/templates/messages/outbox-summary-semantics.test.ts 的真实生产链组合验收。
 * 本 set 中的组保留 golden 历史数据但不逐字节
 * 比较；新语义由 tests/core/contract/verification-notice-context.test.ts、
 * tests/core/contract/contract-audit-feedback-context.test.ts 等逐分支接管。
 * 完整性 = 保留比较的组 + 新语义接管的组 = 全部 fixture 组。
 */
const SEMANTICALLY_REDESIGNED_GROUPS = new Set(['M03', 'M06', 'M07']);

/**
 * phase 1832: M04/M05 的契约完成 case 移交新语义验收（case 级接管，非整组豁免）。
 * phase 1833: 取消 case 同样接管（M04/contract_cancelled、M05/c-cancelled:cancelled、
 * M05/observer:contract_cancelled）。接管 case 由本测试内的新语义断言与
 * tests/core/contract/contract-completed-message-context.test.ts /
 * contract-cancelled-message-context.test.ts 真实两路测试覆盖。
 * M05/c-corrupted:corrupted、c-failed:failed 继续逐字节比较。
 * phase 1834: M12/outbox-labels 随 read-outbox 用途标签变更（CLIProtocol 持有该
 * 文案）移交新语义——旧两行含 skip 配对的 renderer 样本不作新行为依据；其余四个
 * M12 case 继续逐字节比较，M12 不作整组接管。
 * phase 1835: M09/completion 移交新语义（正文自含任务/输出块数/产物路径/按需读取
 * 用途，不再将块数称为 contracts），由本测试现场精确断言与
 * tests/templates/messages/random-dream-notice-semantics.test.ts 真实链接管；
 * M09 不作整组接管。
 */
const SEMANTICALLY_REDESIGNED_CASES: Record<string, ReadonlySet<string>> = {
  M04: new Set(['contract_events', 'contract_cancelled']),
  M05: new Set([
    'c-completed:completed',
    'observer:contract_events',
    'c-cancelled:cancelled',
    'observer:contract_cancelled',
  ]),
  M09: new Set(['completion']),
  M12: new Set(['outbox-labels']),
};

/** 已逐字节比较过的 case（`${group}/${case}`），供完整性核对。 */
const comparedCases = new Set<string>();

/** 用迁移后入口的实际输出与冻结 golden 逐字节比较（body + envelope + case 集合）。 */
function expectCases(group: string, actual: Case[]): void {
  asserted.add(group);
  for (const c of actual) comparedCases.add(`${group}/${c.case}`);
  const expected = fixture.cases[group];
  expect(expected, `fixture missing group ${group}`).toBeDefined();
  expect(actual, `group ${group} case mismatch`).toEqual(expected);
}

/**
 * phase 1832 case 级接管：接管 case 从逐字节比较中剔除（新语义断言由调用方现场写），
 * 其余 case 继续与 golden 逐字节比较；完整性核仍要求「逐字比较 case + 接管 case」
 * 恰好等于 fixture case 集合。
 */
function expectCasesExceptRedesigned(group: string, actual: Case[]): Case[] {
  const takeover = SEMANTICALLY_REDESIGNED_CASES[group] ?? new Set<string>();
  const kept = actual.filter(c => !takeover.has(c.case));
  const takenOver = actual.filter(c => takeover.has(c.case));
  expect(takenOver.map(c => c.case).sort(), `group ${group} takeover case missing`)
    .toEqual([...takeover].sort());
  asserted.add(group);
  for (const c of kept) comparedCases.add(`${group}/${c.case}`);
  const expected = fixture.cases[group].filter(c => !takeover.has(c.case));
  expect(kept, `group ${group} case mismatch`).toEqual(expected);
  return takenOver;
}

interface Case {
  case: string;
  body: string;
  envelope?: Record<string, unknown>;
}
const tmpRoots: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fsNative.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

const auditStub = (): AuditLog => ({ write: () => {} }) as unknown as AuditLog;

afterAll(() => {
  // 完整性：fixture 的每一组都必须被本测试断言过，或显式移交新语义验收（防漏测组）
  expect([...asserted, ...SEMANTICALLY_REDESIGNED_GROUPS].sort()).toEqual(Object.keys(fixture.cases).sort());
  // phase 1832 case 级完整性：非整组移交的每个 fixture case 要么被逐字节比较，
  // 要么登记在 case 级接管表（防整组被无条件放过）
  for (const [group, cases] of Object.entries(fixture.cases)) {
    if (SEMANTICALLY_REDESIGNED_GROUPS.has(group)) continue;
    for (const c of cases) {
      const takenOver = SEMANTICALLY_REDESIGNED_CASES[group]?.has(c.case) ?? false;
      expect(
        comparedCases.has(`${group}/${c.case}`) || takenOver,
        `fixture case ${group}/${c.case} neither compared nor taken over`,
      ).toBe(true);
    }
  }
  for (const dir of tmpRoots) {
    fsNative.rmSync(dir, { recursive: true, force: true });
  }
});

describe('phase 1828 inbox 文案等价（迁移后入口 vs 迁移前 golden）', () => {
  it('M01 execution_recovery resume body', () => {
    const baseDir = tmpDir('p1828-m01-');
    const agentDir = path.join(baseDir, 'claws', 'claw-1');
    const pendingDir = path.join(agentDir, 'inbox', 'pending');
    fsNative.mkdirSync(pendingDir, { recursive: true });
    const loop = new EventLoop({
      runtime: {} as never,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      agentDir,
      clawId: 'claw-1',
      audit: auditStub(),
      inbox: { pendingDir },
    });
    (loop as unknown as { _enqueueExecutionResume(r: { contractId: string; attempts: number }): void })
      ._enqueueExecutionResume({ contractId: '1700000000000-abcd', attempts: 2 });
    const file = fsNative.readdirSync(pendingDir).find(f => f.endsWith('.md'))!;
    const msg = decodeInbox(fsNative.readFileSync(path.join(pendingDir, file), 'utf8'));
    expectCases('M01', [{
      case: 'stalled-contract',
      body: msg.content,
      envelope: { type: msg.type, from: msg.from, to: msg.to, priority: msg.priority },
    }]);
    expect(msg.content).toContain('Execution stalled');
  });

  it('M02 startup_check body', async () => {
    const agentDir = tmpDir('p1828-m02-');
    fsNative.mkdirSync(path.join(agentDir, 'contract', 'active', 'c-live'), { recursive: true });
    fsNative.mkdirSync(path.join(agentDir, 'inbox', 'pending'), { recursive: true });
    const agentFs = new NodeFileSystem({ baseDir: agentDir });
    const clawFs = new NodeFileSystem({ baseDir: agentDir });
    const writes: string[] = [];
    const original = clawFs.writeAtomicSync.bind(clawFs);
    (clawFs as unknown as { writeAtomicSync(p: string, c: string): void }).writeAtomicSync =
      (p: string, c: string) => { writes.push(p); original(p, c); };
    const delivery = createStartupCheckDelivery({ agentFs, clawFs, agentDir, audit: auditStub() });
    const result = delivery.deliver();
    expect(['fired', 'not_eligible', 'pending_retry']).toContain(result.kind);
    const pendingDir = path.join(agentDir, 'inbox', 'pending');
    const files = fsNative.existsSync(pendingDir) ? fsNative.readdirSync(pendingDir).filter(f => f.endsWith('.md')) : [];
    if (files.length === 0) {
      // startup check eligibility 依赖环境；无消息时记录 not_eligible，由既有链路测试补
      expectCases('M02', [{ case: 'not-delivered', body: `(no message; result=${result.kind})` }]);
      return;
    }
    const msg = decodeInbox(fsNative.readFileSync(path.join(pendingDir, files[0]), 'utf8'));
    expectCases('M02', [{
      case: 'startup-check',
      body: msg.content,
      envelope: { type: msg.type, from: msg.from, to: msg.to, priority: msg.priority },
    }]);
  });

  it('M03 已移交 phase 1829 语义验收，保留 golden 历史数据但不逐字节比较', () => {
    // 反向完整性：M03 仍在 fixture（历史数据保留），且显式登记为语义重设计组。
    expect(fixture.cases.M03).toBeDefined();
    expect(fixture.cases.M03.length).toBeGreaterThanOrEqual(8);
    expect(SEMANTICALLY_REDESIGNED_GROUPS.has('M03')).toBe(true);
    expect(asserted.has('M03')).toBe(false);
  });

  it('M04 contract notification envelope body', () => {
    const baseDir = tmpDir('p1828-m04-');
    const pendingDir = path.join(baseDir, 'inbox', 'pending');
    fsNative.mkdirSync(pendingDir, { recursive: true });
    const systemFs = new NodeFileSystem({ baseDir });
    const sink = createContractNotificationAdapter({
      streamWriter: { write: () => {} } as never,
      clawId: 'motion',
      systemFs,
      selfInboxDir: pendingDir,
      auditWriter: auditStub(),
    });
    sink({
      type: 'contract_completed',
      contractId: 'c-9',
      title: '演示「标题」',
      goal: '目标\n多行',
      completedAt: '2026-09-11T00:00:00.000Z',
      subtasks: [{ id: 'st-1', completedAt: '2026-09-11T00:01:00.000Z', forceAccepted: false }],
    } as never);
    sink({ type: 'contract_cancelled', contractId: 'c-9', reason: 'user manual' } as never);
    const files = fsNative.readdirSync(pendingDir).filter(f => f.endsWith('.md'));
    const messages = files.map(f => decodeInbox(fsNative.readFileSync(path.join(pendingDir, f), 'utf8')));
    const allCases = messages.map(msg => ({
      case: String(msg.type),
      body: msg.content,
      envelope: { type: msg.type, from: msg.from, to: msg.to, priority: msg.priority },
    }));
    // phase 1832/1833: completed/cancelled case 均移交新语义，现场断言精确正文+envelope
    const takenOver = expectCasesExceptRedesigned('M04', allCases);
    const expectedM04: Record<string, string> = {
      contract_events:
        '契约流程已完成｜演示「标题」（c-9）\n'
        + '执行者：motion\n'
        + '原目标：目标\n多行\n'
        + '完成时间：2026-09-11T00:00:00.000Z\n'
        + '已完成子任务：\n'
        + '  [st-1] 完成时间：2026-09-11T00:01:00.000Z',
      contract_cancelled:
        '契约已取消｜c-9\n'
        + '执行者：motion\n'
        + '取消原因：user manual',
    };
    for (const c of takenOver) {
      expect(c.body).toBe(expectedM04[c.case]);
    }
    const completed = takenOver.find(c => c.case === 'contract_events')!;
    expect(completed.envelope).toEqual({ type: 'contract_events', from: 'system', to: '', priority: 'high' });
    const cancelled = takenOver.find(c => c.case === 'contract_cancelled')!;
    expect(cancelled.envelope).toEqual({ type: 'contract_cancelled', from: 'system', to: '', priority: 'high' });
    expect(messages.length).toBe(2);
  });

  it('M05 contract events entry bodies + observer composition', async () => {
    const now = Date.now();
    const files = new Map<string, string>();
    const dirs = new Map<string, Array<{ name: string; isDirectory: boolean; size: number }>>();
    const root = '/obs/claws/claw-1/contract/archive';
    files.set(`${root}/completed/c-completed/progress.json`, JSON.stringify({
      schema_version: 1, contract_id: 'c-completed', status: 'completed',
      subtasks: {
        'st-1': { status: 'completed', completed_at: new Date(now).toISOString(), evidence: 'done part 1' },
        'st-2': { status: 'completed', completed_at: new Date(now).toISOString(), evidence: 'done "part 2"', last_failed_feedback: { feedback: '曾失败一次' } },
      },
    }));
    files.set(`${root}/completed/c-completed/contract.yaml`, 'title: 演示契约\ngoal: "多行\n目标"\n');
    files.set(`${root}/cancelled/c-cancelled/progress.json`, JSON.stringify({
      schema_version: 1, contract_id: 'c-cancelled', status: 'cancelled', checkpoint: 'cancelled: user manual',
      subtasks: { 'st-1': { status: 'completed', completed_at: new Date(now).toISOString() } },
    }));
    files.set(`${root}/corrupted/c-corrupted/progress.json`, JSON.stringify({
      schema_version: 1, contract_id: 'c-corrupted', status: 'running', subtasks: {},
    }));
    files.set(`${root}/failed/c-failed/progress.json`, JSON.stringify({
      schema_version: 1, contract_id: 'c-failed', status: 'running', subtasks: {},
    }));
    files.set(lifecycleIntentPath('/obs/claws/claw-1', 'c-failed' as never, 'req-1'), JSON.stringify({
      schema_version: 1,
      request_id: 'req-1',
      contract_id: 'c-failed',
      requested_state: 'failed',
      requested_at: new Date(now).toISOString(),
      failure: { reason: 'executor crashed', evidenceRef: 'logs/run-7.txt', producer: 'subagent' },
    }));
    dirs.set('/obs/claws', [{ name: 'claw-1', isDirectory: true, size: 0 }]);
    dirs.set('/obs/claws/claw-1', [{ name: 'contract', isDirectory: true, size: 0 }]);
    dirs.set('/obs/claws/claw-1/contract', [{ name: 'archive', isDirectory: true, size: 0 }]);
    dirs.set(root, [
      { name: 'completed', isDirectory: true, size: 0 },
      { name: 'cancelled', isDirectory: true, size: 0 },
      { name: 'corrupted', isDirectory: true, size: 0 },
      { name: 'failed', isDirectory: true, size: 0 },
    ]);
    dirs.set(`${root}/completed`, [{ name: 'c-completed', isDirectory: true, size: 0 }]);
    dirs.set(`${root}/cancelled`, [{ name: 'c-cancelled', isDirectory: true, size: 0 }]);
    dirs.set(`${root}/corrupted`, [{ name: 'c-corrupted', isDirectory: true, size: 0 }]);
    dirs.set(`${root}/failed`, [{ name: 'c-failed', isDirectory: true, size: 0 }]);
    files.set('/obs/motion/status/contract-observer-state.json', JSON.stringify({
      version: 7,
      lastCheckTs: 0,
      lastArchivedAt: 0,
      clawWatermarks: {},
      bootstrapDone: true,
      completedWatermarks: {},
      cancelledWatermarks: {},
      crashedWatermarks: {},
      reportedCorrupted: {},
      reportedActiveState: {},
      retrospectiveWatermarks: {},
    }));
    dirs.set('/obs/motion', [{ name: 'status', isDirectory: true, size: 0 }]);
    dirs.set(`/obs/claws/claw-1/contract/lifecycle-intents`, [{ name: 'c-failed', isDirectory: true, size: 0 }]);
    dirs.set(`/obs/claws/claw-1/contract/lifecycle-intents/c-failed`, [{ name: 'req-1.json', isDirectory: false, size: 1 }]);

    const writes = new Map<string, string>();
    const fsStub = {
      existsSync: (p: string) => dirs.has(p) || files.has(p),
      listSync: (p: string) => dirs.get(p) ?? [],
      readSync: (p: string) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v; },
      read: async (p: string) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v; },
      exists: async (p: string) => dirs.has(p) || files.has(p),
      list: async (p: string) => dirs.get(p) ?? [],
      ensureDirSync: () => {},
      writeAtomicSync: (p: string, c: string) => { writes.set(p, c); },
    } as unknown as FileSystem;

    const { entries } = await scanArchivedContracts(fsStub, '/obs/claws/claw-1', 'claw-1' as never, auditStub());
    const entryCases: Case[] = entries.map(e => ({
      case: `${e.contractId}:${e.status}`,
      body: e.body,
      envelope: { hasFailure: e.hasFailure, status: e.status },
    }));
    expect(entries.length).toBe(4);

    // observer 组合（join('\n\n')）
    const clawTopology = {
      enumerate: () => ['claw-1'],
      resolve: (clawId: string) => ({ kind: 'local', clawDir: `/obs/claws/${clawId}` }),
      read: async () => '',
      readJSON: async () => ({}),
    } as never;
    const notified: Array<Record<string, unknown>> = [];
    await runContractObserver({
      clawsDir: '/obs/claws',
      clawTopology,
      motionDir: '/obs/motion',
      fs: fsStub,
      motionAudit: auditStub(),
      notifyMotion: async (m: Record<string, unknown>) => { notified.push(m); },
    } as never);
    const m05Cases = [
      ...entryCases,
      ...notified.map(m => ({
        case: `observer:${String(m.type)}`,
        body: String(m.body),
        envelope: { type: m.type, from: m.source, priority: m.priority },
      })),
    ];
    // phase 1832/1833: 完成/取消 case（entry + observer 组合）移交新语义；损坏/失败继续逐字节比较
    const takenOver = expectCasesExceptRedesigned('M05', m05Cases);
    const expectedCompletedBody =
      '契约流程已完成｜演示契约（c-completed）\n'
      + '执行者：claw-1\n'
      + '原目标：多行 目标\n'
      + '已完成子任务：\n'
      + '  [st-1] 执行者提交材料：done part 1\n'
      + '  [st-2] 执行者提交材料：done "part 2"\n'
      + '    历史验收反馈（该子任务保留的最近一次未通过反馈，不能仅凭此记录判断最终验收结论）：曾失败一次';
    const expectedCancelledBody =
      '契约已取消｜c-cancelled\n'
      + '执行者：claw-1\n'
      + '历史检查点记录的取消原因：user manual\n'
      + '取消前已完成子任务：\n'
      + '  [st-1]';
    const expectedM05: Record<string, string> = {
      'c-completed:completed': expectedCompletedBody,
      'observer:contract_events': expectedCompletedBody,
      'c-cancelled:cancelled': expectedCancelledBody,
      'observer:contract_cancelled': expectedCancelledBody,
    };
    for (const c of takenOver) {
      expect(c.body).toBe(expectedM05[c.case]);
    }
    const entryCase = takenOver.find(c => c.case === 'c-completed:completed')!;
    expect(entryCase.envelope).toEqual({ hasFailure: true, status: 'completed' });
    const observerCase = takenOver.find(c => c.case === 'observer:contract_events')!;
    expect(observerCase.envelope).toEqual({ type: 'contract_events', from: 'system', priority: 'high' });
    const cancelledEntry = takenOver.find(c => c.case === 'c-cancelled:cancelled')!;
    expect(cancelledEntry.envelope).toEqual({ hasFailure: true, status: 'cancelled' });
    const observerCancelled = takenOver.find(c => c.case === 'observer:contract_cancelled')!;
    expect(observerCancelled.envelope).toEqual({ type: 'contract_cancelled', from: 'system', priority: 'high' });
    expect(notified.length).toBeGreaterThanOrEqual(1);
  });

  it('M06 已移交 phase 1830 语义验收，保留 golden 历史数据但不逐字节比较', () => {
    // 反向完整性：M06 仍在 fixture（历史数据保留），且显式登记为语义重设计组。
    expect(fixture.cases.M06).toBeDefined();
    expect(fixture.cases.M06.length).toBeGreaterThanOrEqual(1);
    expect(SEMANTICALLY_REDESIGNED_GROUPS.has('M06')).toBe(true);
    expect(asserted.has('M06')).toBe(false);
  });

  it('M07 已移交 phase 1834 语义验收，保留 golden 历史数据但不逐字节比较', () => {
    // 反向完整性：M07 仍在 fixture（历史数据保留，含旧 skip 提示正文），且显式登记
    // 为语义重设计组；新语义由 outbox-summary-semantics.test.ts 真实生产链接管。
    expect(fixture.cases.M07).toBeDefined();
    expect(fixture.cases.M07.length).toBeGreaterThanOrEqual(1);
    expect(SEMANTICALLY_REDESIGNED_GROUPS.has('M07')).toBe(true);
    expect(asserted.has('M07')).toBe(false);
  });

  it('M08 heartbeat formatter outputs', async () => {
    const cases: Case[] = [];
    const base = '[system message<t>]';
    void base;
    const withChecklist = {
      systemFs: { read: async () => '# 检查清单\n\n- 看一眼 outbox\n' } as never,
      audit: auditStub(),
    };
    const formatted = await createHeartbeatInboxFormatter(withChecklist)({ body: '', timestampSec: 12345 } as never);
    cases.push({ case: 'with-checklist', body: formatted });

    const missing = {
      systemFs: { read: async () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); } } as never,
      audit: auditStub(),
    };
    cases.push({ case: 'missing-file', body: await createHeartbeatInboxFormatter(missing)({ body: '', timestampSec: 12345 } as never) });

    const failedAudit: Array<[string, ...unknown[]]> = [];
    const otherError = {
      systemFs: { read: async () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); } } as never,
      audit: { write: (type: string, ...cols: unknown[]) => { failedAudit.push([type, ...cols]); } } as never,
    };
    cases.push({ case: 'non-enoent-error', body: await createHeartbeatInboxFormatter(otherError)({ body: '', timestampSec: 12345 } as never) });
    expectCases('M08', cases);
    expect(failedAudit.length).toBe(1);
    expect(cases[0].body).toContain('Heartbeat triggered');
  });

  it('M09 random dream completion body', async () => {
    const chestnutRoot = tmpDir('p1828-m09-');
    const motionDir = path.join(chestnutRoot, 'motion');
    fsNative.mkdirSync(path.join(motionDir, 'inbox', 'pending'), { recursive: true });
    const contractDir = path.join(chestnutRoot, 'claws', 'claw-1', 'contract', 'archive', 'contract-001');
    fsNative.mkdirSync(contractDir, { recursive: true });
    const taskId = 'direct-1';
    const resultDir = path.join(motionDir, 'tasks', 'queues', 'results', taskId);
    fsNative.mkdirSync(resultDir, { recursive: true });
    fsNative.writeFileSync(path.join(resultDir, 'result.txt'), 'done');
    fsNative.writeFileSync(path.join(resultDir, 'daemon.log'), `[DREAM_OUTPUT contract_id="contract-001"]insight[/DREAM_OUTPUT]`);
    const fileSystem = new NodeFileSystem({ baseDir: chestnutRoot });
    const notified: Array<Record<string, unknown>> = [];
    const taskSystem = {
      schedule: async () => taskId,
      shutdown: async () => true,
    } as unknown as AsyncTaskSystemType;
    await runRandomDream({
      clawTopology: createClawTopology({ fs: fileSystem, chestnutRoot, motionDir }),
      motionDir: motionDir as never,
      taskSystem,
      fs: fileSystem,
      motionFs: new NodeFileSystem({ baseDir: motionDir }),
      audit: { write: () => {}, preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as never,
      notifyMotion: async (m: Record<string, unknown>) => { notified.push(m); },
      subagentTimeoutMs: 1000,
      pulseIntervalMs: 10,
    } as never);
    const msg = notified.find(m => m.type === 'random_dream_completed');
    expect(msg).toBeTruthy();
    // phase 1835: M09/completion 移交新语义，现场断言精确正文+envelope（literal expected，不经模板生成）
    const takenOver = expectCasesExceptRedesigned('M09', [{
      case: 'completion',
      body: String(msg?.body ?? ''),
      envelope: { type: msg?.type, from: msg?.source, priority: msg?.priority },
    }]);
    expect(takenOver).toEqual([{
      case: 'completion',
      body:
        '跨 claw 经验探索输出已保存。\n'
        + '任务：direct-1\n'
        + '产物：1 个输出块\n'
        + '位置：motion 目录下的 memory/dream-outputs/direct-1.txt\n'
        + '\n'
        + '这些内容来自对已归档契约的探索，尚未自动整理为可检索的长期记忆。\n'
        + '需要参考这些经验时，可读取该文件，再判断哪些内容值得整理或采用。',
      envelope: { type: 'random_dream_completed', from: 'random-dream', priority: 'normal' },
    }]);
    void MEMORY_AUDIT_EVENTS;
    void MOTION_CLAW_ID;
  });

  it('M10 system envelope renderings', () => {
    expectCases('M10', [
      {
        case: 'system',
        body: renderStandardInboxMessage({ body: '正文 body "x"\n第二行', timestampSec: 987 }, 'system'),
        envelope: { prefix: SYSTEM_MESSAGE_PREFIX },
      },
      {
        case: 'user_inbox',
        body: renderStandardInboxMessage({ body: '用户原文', timestampSec: 987 }, 'user_inbox'),
      },
      { case: 'user_chat', body: renderStandardInboxMessage({ body: '直接正文', timestampSec: 987 }, 'user_chat') },
    ]);
    expect(fixture.cases.M10[0].body.startsWith(SYSTEM_MESSAGE_PREFIX)).toBe(true);
  });

  it('M11 task queue overflow texts', async () => {
    const cases: Case[] = [
      { case: 'guidance', body: overflowComposer({ cap: '3', queue_length: '4' } as never).text },
    ];

    const baseDir = tmpDir('p1828-m11-');
    for (const sub of ['pending', 'done', 'failed', 'running', 'results']) {
      fsNative.mkdirSync(path.join(baseDir, 'tasks', 'queues', sub), { recursive: true });
    }
    fsNative.mkdirSync(path.join(baseDir, 'sync'), { recursive: true });
    fsNative.mkdirSync(path.join(baseDir, 'subagents'), { recursive: true });
    fsNative.mkdirSync(path.join(baseDir, 'inbox', 'pending'), { recursive: true });
    const writes: Array<Record<string, unknown>> = [];
    const mockInbox = { writeSync: (msg: Record<string, unknown>) => { writes.push(msg); } } as never;
    const realFs = new NodeFileSystem({ baseDir });
    const system = new AsyncTaskSystem(baseDir, realFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: auditStub(),
      llm: {} as never,
      contractManager: {} as never,
      registry: {} as never,
      selfInbox: mockInbox,
      pendingQueueMax: 3,
    } as never);
    const writePending = (id: string) => {
      fsNative.writeFileSync(path.join(baseDir, 'tasks', 'queues', 'pending', `${id}.json`), JSON.stringify({
        id, kind: 'subagent', mode: 'standard', shortId: id.slice(0, 8), parentClawId: 'parent-claw',
        parentClawDir: baseDir, createdAt: new Date().toISOString(), timeoutMs: 60000, intent: 'test',
      }));
    };
    writePending('overflow-task');
    for (let i = 0; i < 3; i++) writePending(`task-${i}`);
    await (system as unknown as { _enqueueAndDispatch(t: unknown): Promise<void> })
      ._enqueueAndDispatch({ id: 'overflow-task', kind: 'subagent', parentClawId: 'parent-claw', parentClawDir: baseDir });
    const overflowMsg = writes.find(w => w.type === 'task_queue_overflow');
    expect(overflowMsg).toBeTruthy();
    cases.push({
      case: 'overflow-body',
      body: String(overflowMsg?.body ?? ''),
      envelope: { type: overflowMsg?.type, priority: overflowMsg?.priority, extraFields: overflowMsg?.extraFields },
    });
    expectCases('M11', cases);
  });

  it('M12 CLI guidance renderings', () => {
    const claw = createCliSafeToken('worker-1');
    const contract = createCliSafeToken('c-9');
    const docs: Array<{ case: string; doc: CliGuidanceDocument }> = [
      {
        case: 'all-labels-claw-target',
        doc: {
          lines: [
            { label: 'restart', action: { kind: 'claw.daemon', target: { kind: 'claw', id: 'worker-1' } } },
            { label: 'inspect-before-crash', action: { kind: 'claw.status', target: { kind: 'claw', id: 'worker-1' } } },
            { label: 'check-current-status', action: { kind: 'claw.status', target: { kind: 'placeholder', name: 'claw-id' } } },
            { label: 'inspect-current-work', action: { kind: 'claw.steps', target: { kind: 'claw', id: 'worker-1' } } },
            { label: 'inspect-stuck', action: { kind: 'claw.trace', clawId: claw, contractId: contract } },
            { label: 'inspect', action: { kind: 'contract.show', clawId: claw, contractId: contract } },
          ],
        },
      },
      {
        case: 'outbox-labels',
        // phase 1834: read-outbox 用途标签变更后只保留真实读取语义的一行；
        // 旧样本中 read-outbox 与 claw.outbox-skip 的配对是 renderer 样本而非实际
        // M07 binding 输出，不机械改写为新前缀（skip 动作覆盖在 cli-protocol 与 CLI 测试）。
        doc: {
          lines: [
            { label: 'read-outbox', action: { kind: 'claw.outbox', target: { kind: 'claw', id: 'worker-1' }, limit: 20 } },
          ],
        },
      },
      {
        case: 'truncation-contract-events',
        doc: {
          lines: [
            { label: 'inspect', action: { kind: 'contract.show', clawId: claw, contractId: contract } },
          ],
          truncation: { total: 42, shown: 1, subject: 'contract-events' },
        },
      },
      {
        case: 'truncation-cancellations',
        doc: {
          lines: [
            { label: 'restart', action: { kind: 'claw.daemon', target: { kind: 'claw', id: 'worker-1' } } },
          ],
          truncation: { total: 3, shown: 1, subject: 'contract-cancellations' },
        },
      },
      { case: 'empty-no-truncation', doc: { lines: [] } },
    ];
    // phase 1834: outbox-labels 移交新语义（read-outbox 标签变更），其余 case 逐字节比较
    const takenOver = expectCasesExceptRedesigned('M12', docs.map(({ case: c, doc }) => ({ case: c, body: renderCliGuidanceDocument(doc) })));
    expect(takenOver).toEqual([{
      case: 'outbox-labels',
      body: '读取并消费（最多 --limit 指定的条数）：chestnut claw worker-1 outbox --limit 20',
    }]);
    expect(fixture.cases.M12.length).toBe(5);
  });
});
