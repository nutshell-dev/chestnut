/**
 * Phase 1828：inbox 系统文案「迁移前 golden vs 迁移后入口输出」逐字节等价测试。
 *
 * fixture（tests/templates/messages/__fixtures__/inbox-text-golden.json）由迁移前的
 * 捕获器（development log/phase1828-logs/B-capture-golden.test.ts.txt）从旧实现的
 * 真实发送/呈现入口生成一次后固化；本测试用同一批入口与参数重跑，断言 body 与
 * envelope 逐字节相同。禁止用新模板反向生成 expected，禁止更新 fixture 掩盖变化。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fsNative from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { InboxWriter, makeInboxPath, MESSAGING_WRITER_LIMITS_DEFAULT } from '../../../src/foundation/messaging/index.js';
import { EventLoop } from '../../../src/core/event-loop/index.js';
import { createStartupCheckDelivery } from '../../../src/daemon/daemon-loop.js';
import { createContractNotificationAdapter } from '../../../src/assembly/contract-notification-adapter.js';
import { scanArchivedContracts } from '../../../src/core/contract/jobs/event-collector.js';
import { lifecycleIntentPath } from '../../../src/core/contract/lifecycle-intent.js';
import { runContractObserver } from '../../../src/core/contract/jobs/contract-observer.js';
import { ContractAuditor } from '../../../src/core/contract/contract-auditor.js';
import { writeNewSummary, SUMMARY_INBOX_TYPE } from '../../../src/core/claw-topology/jobs/outbox-summary/write.js';
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
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { makeAudit } from '../../helpers/audit.js';

// M07 等价比较：incomplete 状态在 owner codec 处 fail-closed（写盘前 throw），
// 迁移前后都只 stub codec（非消息文本）以取到同一入口的 body 分支。
vi.mock('../../../src/core/claw-topology/jobs/outbox-summary/guidance-state.js', () => ({
  encodeOutboxSummaryGuidance: () => ({}),
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, '__fixtures__', 'inbox-text-golden.json');
const fixture = JSON.parse(fsNative.readFileSync(FIXTURE_PATH, 'utf8')) as {
  cases: Record<string, Case[]>;
};
const asserted = new Set<string>();

/**
 * phase 1829: M03 从逐字节迁移等价移交新的语义验收（通知正文携带身份与已提交处置、
 * 上游系统反馈归位模板）。本 set 中的组保留 golden 历史数据但不逐字节比较；
 * 新语义由 tests/core/contract/verification-notice-context.test.ts 等逐分支接管。
 * 完整性 = 保留比较的组 + 新语义接管的组 = 全部 fixture 组。
 */
const SEMANTICALLY_REDESIGNED_GROUPS = new Set(['M03']);

/** 用迁移后入口的实际输出与冻结 golden 逐字节比较（body + envelope + case 集合）。 */
function expectCases(group: string, actual: Case[]): void {
  asserted.add(group);
  const expected = fixture.cases[group];
  expect(expected, `fixture missing group ${group}`).toBeDefined();
  expect(actual, `group ${group} case mismatch`).toEqual(expected);
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
    expectCases('M04', messages.map(msg => ({
      case: String(msg.type),
      body: msg.content,
      envelope: { type: msg.type, from: msg.from, to: msg.to, priority: msg.priority },
    })));
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
    expectCases('M05', [
      ...entryCases,
      ...notified.map(m => ({
        case: `observer:${String(m.type)}`,
        body: String(m.body),
        envelope: { type: m.type, from: m.source, priority: m.priority },
      })),
    ]);
    expect(notified.length).toBeGreaterThanOrEqual(1);
  });

  it('M06 contract audit feedback body', async () => {
    const baseDir = tmpDir('p1828-m06-');
    const inboxDir = path.join(baseDir, 'inbox', 'pending');
    fsNative.mkdirSync(inboxDir, { recursive: true });
    const nfs = new NodeFileSystem({ baseDir });
    const inbox = InboxWriter.__internal_create(
      nfs, makeInboxPath('inbox/pending'), makeAudit().audit, MESSAGING_WRITER_LIMITS_DEFAULT,
    );
    const verdict = JSON.stringify({
      on_track: false,
      drifts: [{ what: 'grep 循环', evidence: 'step 40-49' }, { what: '未提交', evidence: 'step 50' }],
      next_focus_suggestion: '先提交再继续',
    });
    const llm = {
      async call() {
        return { content: [{ type: 'text', text: verdict }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
      },
      stream: () => { throw new Error('unused'); },
      healthCheck: async () => true,
      getProviderInfo: () => ({ name: 'mock', model: 'mock', isFallback: false }),
      close: async () => {},
    } as unknown as LLMOrchestrator;
    const auditor = new ContractAuditor({ audit: makeAudit().audit, fs: nfs, inbox, llm });
    await auditor.maybeAudit({
      contractId: 'c-1',
      contractTitle: 'Test Contract',
      clawId: 'motion',
      currentStep: 50,
      auditInterval: 50,
      lastAuditedStep: 0,
      expectations: 'do X',
      contractStartedAt: undefined,
      progress: { done: [], in_progress: 's1', pending: ['s2'] },
    } as never);
    const files = fsNative.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
    const messages = files.map(f => decodeInbox(fsNative.readFileSync(path.join(inboxDir, f), 'utf8')));
    expectCases('M06', messages.map(msg => ({
      case: 'audit-feedback',
      body: msg.content,
      envelope: { type: msg.type, from: msg.from, to: msg.to, priority: msg.priority },
    })));
    expect(messages.length).toBe(1);
  });

  it('M07 outbox summary bodies', async () => {
    const written: Array<Record<string, unknown>> = [];
    const writer = { write: async (msg: Record<string, unknown>) => { written.push(msg); } } as never;
    const state = {
      counts: { 'claw-a': 2, 'claw-b': 1 },
      total_claws: 2,
      total_msgs: 3,
      file_set: ['claw-a:a.md', 'claw-a:b.md', 'claw-b:c.md'],
      hash: 'abcdef123456',
      previews: { 'claw-a': '第一行 "引号" 预览', 'claw-b': '' },
      failed_claws: [],
      incomplete: false,
    };
    const deps = {
      inboxWriter: writer,
      audit: auditStub(),
      renderOutboxSkipHint: (id: string) => `chestnut claw ${id} outbox-skip --all`,
      now: () => Date.parse('2026-09-11T00:00:00.000Z'),
    };
    await writeNewSummary(deps as never, state as never, { isRepeat: false });
    await writeNewSummary(deps as never, state as never, { isRepeat: true });
    await writeNewSummary(deps as never, {
      ...state, previews: { 'claw-b': '只有 b 的预览' }, failed_claws: ['claw-c', 'claw-d'], incomplete: true,
    } as never, { isRepeat: true });
    expectCases('M07', written.map(msg => ({
      case: `type=${String(msg.type)}`,
      body: String(msg.content),
      envelope: { type: msg.type, from: msg.from, to: msg.to, priority: msg.priority, extraMeta: msg.extraMeta },
    })));
    expect(written.length).toBe(3);
    expect(String(written[0].type)).toBe(SUMMARY_INBOX_TYPE);
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
    expectCases('M09', [{
      case: 'completion',
      body: String(msg?.body ?? ''),
      envelope: { type: msg?.type, from: msg?.source, priority: msg?.priority },
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
        doc: {
          lines: [
            { label: 'read-outbox', action: { kind: 'claw.outbox', target: { kind: 'claw', id: 'worker-1' }, limit: 20 } },
            { label: 'read-outbox', action: { kind: 'claw.outbox-skip', target: { kind: 'claw', id: 'worker-1' } } },
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
    expectCases('M12', docs.map(({ case: c, doc }) => ({ case: c, body: renderCliGuidanceDocument(doc) })));
    expect(fixture.cases.M12.length).toBe(5);
  });
});
