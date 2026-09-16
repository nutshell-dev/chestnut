/**
 * Phase 1844 组合行为：真实 LLM owner（createLLMOrchestrator + createRecoverySession）
 * + 真实 EventLoop.run + 真实 Messaging inbox + 假 provider（仅模拟网络边界、计数
 * 真实调用）。验证「owner 公开安排是尚未到时的 at 时，不登记新执行提醒」，及到期 /
 * 用户提前 / on_change 启动 / 既有 pending 义务的边界。
 *
 * 时钟：共享受控变量 sharedNow——owner now 回调与 EventLoop/controller 的 Date.now
 * 经 vi.spyOn 取同一变量；推进共享时钟代替真实 sleep，结束恢复 Date.now。
 *
 * 边界说明：runtime 是窄测试驱动（真实 InboxReader.peekPending/drainAndDeliver/ack
 * 与真实 scoped llm 调用），不是完整 Runtime 执行器——本文件不宣称验证智能体完成
 * 契约，只验证 run/owner/provider 与消息链的组合事实。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fsNative from 'fs';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { EventLoop } from '../../../src/core/event-loop/index.js';
import { createExecutionRecoveryStore } from '../../../src/core/event-loop/execution-recovery.js';
import { EVENTLOOP_AUDIT_EVENTS } from '../../../src/core/event-loop/audit-events.js';
import { EXECUTION_RECOVERY_DIR } from '../../../src/core/event-loop/constants.js';
import { createInboxReader, writeInboxAsync } from '../../../src/foundation/messaging/index.js';
import type { InboxHandle } from '../../../src/foundation/messaging/index.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { createLLMOrchestrator, createRecoverySession } from '../../../src/foundation/llm-orchestrator/index.js';
import type {
  LLMEventSink,
  LLMRecoverySession,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/index.js';
import type { ProviderAdapter, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';
import { LLMAuthError } from '../../../src/foundation/llm-provider/errors.js';

const CLAW_ID = 'worker';
const CONTRACT_ID = 'contract-1844';
const RECOVERY_TIMEOUT_MS = 1000;
const BASE_NOW = 1_800_000_000_000;
const OK_RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
};

/** 共享受控时钟：owner now 回调与 Date.now spy 读同一变量。 */
let sharedNow = BASE_NOW;

const cleanupDirs: string[] = [];

beforeEach(() => {
  sharedNow = BASE_NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => sharedNow);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of cleanupDirs.splice(0)) {
    try { await cleanupTempDir(dir); } catch { /* ignore */ }
  }
});

function providerConfig(): ProviderConfig {
  return {
    name: 'primary',
    apiKey: 'key-primary',
    model: 'model-primary',
    temperature: 0,
    timeoutMs: 1_000,
    apiFormat: 'anthropic',
  };
}

interface Fixture {
  rootDir: string;
  /** claw agentDir（<root>/claws/worker）。 */
  dir: string;
  pendingDir: string;
  doneDir: string;
  fs: NodeFileSystem;
  /** 停滞观察基线（sharedNow - 10*timeout，在 fixture 创建时冻结）。 */
  activityAt: number;
  readonly session: LLMRecoverySession;
  /** 重启：新 session 读取原目录（真实恢复链）。 */
  reopen: () => void;
  /** 推进共享时钟（owner 与 EventLoop 同时看到）。 */
  advance: (ms: number) => void;
  /** 之后的 provider 调用成功（不清除 owner 已记录的等待）。 */
  succeed: () => void;
  providerCalls: () => number;
  /** owner 持久状态字节（审计「纯观察不改状态」用）。 */
  stateBytes: () => string;
}

/**
 * 真实产品链建立「未来 at」（quota 失败）或「on_change」（auth 失败）：
 * begin → scoped llm.call 真实抛错 → finish(failed)，由 owner 自己生成等待安排，
 * 不手写 owner 状态 JSON。
 */
async function makeFixture(failure: 'quota' | 'auth'): Promise<Fixture> {
  const rootDir = await createTrackedTempDir('exec-recovery-llm-wait-');
  cleanupDirs.push(rootDir);
  const dir = path.join(rootDir, 'claws', CLAW_ID);
  const pendingDir = path.join(dir, 'inbox', 'pending');
  const doneDir = path.join(dir, 'inbox', 'done');
  fsNative.mkdirSync(pendingDir, { recursive: true });
  const fs = new NodeFileSystem({ baseDir: dir });

  let providerCalls = 0;
  let providerError: Error | undefined =
    failure === 'auth' ? new LLMAuthError('primary') : new Error('insufficient quota');
  const adapter: ProviderAdapter = {
    name: 'primary',
    model: 'model-primary',
    call: async () => {
      providerCalls += 1;
      if (providerError) throw providerError;
      return OK_RESPONSE;
    },
    stream: async function* () { throw new Error('stream unused in this suite'); },
  };

  const sink: LLMEventSink = { emit: () => { /* events not under test */ } };
  const orchestrator = createLLMOrchestrator({
    primary: providerConfig(),
    maxAttempts: 1,
    retryDelayMs: 1,
    events: sink,
    createAnthropicAdapter: () => adapter,
  });
  let session = createRecoverySession({
    scopeId: 'foreground',
    fs,
    events: sink,
    orchestrator,
    now: () => sharedNow,
  });

  // 真实失败产生 owner 等待安排
  const admission = await session.begin({ requestKey: 'fp-1844', facts: { interventionIds: [] } });
  if (admission.kind !== 'admitted') throw new Error('fixture: expected initial admission');
  await expect(
    session.llm.call({ messages: [{ role: 'user', content: 'work' }] }),
  ).rejects.toThrow();
  await session.finish(admission.attemptId, 'failed');

  return {
    rootDir,
    dir,
    pendingDir,
    doneDir,
    fs,
    activityAt: sharedNow - 10 * RECOVERY_TIMEOUT_MS,
    get session() { return session; },
    reopen: () => {
      session = createRecoverySession({
        scopeId: 'foreground',
        fs,
        events: sink,
        orchestrator,
        now: () => sharedNow,
      });
    },
    advance: (ms) => { sharedNow += ms; },
    succeed: () => { providerError = undefined; },
    providerCalls: () => providerCalls,
    stateBytes: () =>
      fsNative.readFileSync(path.join(dir, 'status', 'llm-recovery-state.json'), 'utf8'),
  };
}

type AuditEntry = [string, ...(string | number)[]];

interface RunOutcome {
  auditEntries: AuditEntry[];
  /** processTurn 真实执行次数（每次都会真实调用 session.llm）。 */
  processed: number;
}

/**
 * 窄测试驱动 runtime：真实 peekPending/drainAndDeliver/ack，processTurn 真实调用
 * scoped session.llm（假 provider 计数即真实请求计数）。普通等待 fallback 设小值；
 * 从既有 recovery_wait 审计点 abort 收束，finally 确保运行结束不遗留后台 run。
 */
async function runLoop(f: Fixture): Promise<RunOutcome> {
  const auditEntries: AuditEntry[] = [];
  let loop: EventLoop | undefined;
  const audit = {
    write: (type: string, ...cols: (string | number)[]) => {
      auditEntries.push([type, ...cols]);
      // 既有 recovery_wait 审计点 = 已进入 owner 安排的等待：收束本次 run
      if (cols.includes('type=recovery_wait')) loop?.abort();
    },
  };
  const reader = createInboxReader(f.fs, audit, 'inbox');
  await reader.init();
  let processed = 0;

  const runtime = {
    abort: () => {},
    getCurrentTraceId: () => undefined,
    computeTurnRequestFingerprint: async () => 'fp-1844',
    peekPendingTurnFacts: async () => {
      const view = await reader.peekPending();
      return { addressed: view.entries.map(e => e.message), controls: [] };
    },
    peekPendingInterventionFacts: async () => {
      const view = await reader.peekPending();
      return {
        userIds: view.entries
          .filter(e => e.message.type === 'user_chat' || e.message.type === 'user_inbox_message')
          .map(e => e.message.id),
      };
    },
    consumePendingControls: async () => ({ consumed: 0 }),
    drainInbox: async () => {
      const result = await reader.drainAndDeliver();
      if (result.kind !== 'complete') throw new Error('partial drain not expected');
      return {
        injected: result.entries.map(e => ({ role: 'user' as const, content: e.message.content })),
        sources: result.entries.map(e => ({ text: e.message.content, type: e.message.type })),
        count: result.entries.length,
        addressedHandles: result.handles,
      };
    },
    getMessages: async () => [],
    getSystemPrompt: async () => 'sys',
    getToolsForLLM: () => [],
    proactiveTrimIfNeeded: async (m: unknown[]) => m,
    processTurn: async () => {
      processed += 1;
      try {
        await f.session.llm.call({ messages: [{ role: 'user', content: 'turn' }] });
        return { status: 'success' as const };
      } catch (error) {
        return { status: 'failed' as const, error };
      }
    },
    ackHandles: async (handles: InboxHandle[]) => {
      for (const h of handles) await reader.ack(h);
    },
    nackHandles: async (handles: InboxHandle[], reason: string) => {
      for (const h of handles) await reader.nack(h, reason);
    },
    reactiveTrim: async () => {
      throw new Error('reactiveTrim not expected in these tests');
    },
  };

  loop = new EventLoop({
    runtime: runtime as never,
    fsFactory: (baseDir: string) =>
      baseDir === f.dir ? f.fs : new NodeFileSystem({ baseDir }),
    agentDir: f.dir,
    clawId: CLAW_ID,
    audit: audit as never,
    inbox: { pendingDir: f.pendingDir, fallbackTimeoutMs: 20 },
    recovery: f.session,
    executionRecovery: {
      probeActivity: async () => ({
        activeContractId: CONTRACT_ID,
        lastActivityAt: f.activityAt,
      }),
      timeoutMs: RECOVERY_TIMEOUT_MS,
    },
  });
  await loop.initialize();
  try {
    await loop.run();
  } finally {
    loop.abort();
  }
  return { auditEntries, processed };
}

function recordPath(f: Fixture): string {
  return path.join(f.dir, EXECUTION_RECOVERY_DIR, `${CONTRACT_ID}.json`);
}

/** 按消息 type 计数（不能把用户消息数当提醒数）。 */
function messagesByType(dir: string, type: string): string[] {
  if (!fsNative.existsSync(dir)) return [];
  return fsNative.readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => decodeInbox(fsNative.readFileSync(path.join(dir, name), 'utf8')))
    .filter(m => m.type === type)
    .map(m => m.id);
}

function scheduleCheckAudits(entries: AuditEntry[]): AuditEntry[] {
  return entries.filter(e =>
    e.some(col => String(col) === 'context=executionRecoveryScheduleCheck'));
}

describe('execution-recovery LLM 等待期抑制组合（Phase 1844）', () => {
  it('未来 at + 空 pending：不登记提醒/record，纯观察不改 owner 字节与 revision，无 provider 新请求，不进入准入等待', async () => {
    const f = await makeFixture('quota');
    // 重启：新 session 读取原目录，inspect 仍是未来 at
    f.reopen();
    const schedule = await f.session.inspect();
    expect(schedule.kind).toBe('at');
    const bytesBefore = f.stateBytes();

    const r = await runLoop(f);

    // 无新提醒：pending 无任何消息，record 未建立
    expect(fsNative.readdirSync(f.pendingDir).filter(n => n.endsWith('.md'))).toHaveLength(0);
    expect(fsNative.existsSync(recordPath(f))).toBe(false);
    // 纯观察不改 owner：状态字节与 revision 不变，无新 provider 请求
    expect(f.stateBytes()).toBe(bytesBefore);
    expect((await f.session.inspect()).revision).toBe(schedule.revision);
    expect(f.providerCalls()).toBe(1);
    expect(r.processed).toBe(0);
    // 抑制审计留证；空工作不进入准入（无 recovery_wait）
    const checks = scheduleCheckAudits(r.auditEntries);
    expect(checks).toHaveLength(1);
    expect(checks[0][0]).toBe(EVENTLOOP_AUDIT_EVENTS.ITERATION);
    expect(checks[0].some(col => String(col) === 'reason=llm_retry_scheduled')).toBe(true);
    expect(r.auditEntries.some(e => e.some(col => String(col) === 'type=recovery_wait'))).toBe(false);
  });

  it('到期 at：推进共享时钟到 deadline 后 run 登记提醒、真实 owner 准入、provider 成功一次、消息真实消费落 done', async () => {
    const f = await makeFixture('quota');
    f.succeed();
    const schedule = await f.session.inspect();
    if (schedule.kind !== 'at') throw new Error('expected at schedule');
    // 推进到 deadline（resumeAt === now 已到期，不因 inspect 仍返回 at 继续抑制）
    sharedNow = Date.parse(schedule.resumeAt);

    const r = await runLoop(f);

    expect(r.processed).toBe(1);
    expect(f.providerCalls()).toBe(2);
    // 提醒真实生成并被消费落 done（恰好 1 条 execution_recovery）
    expect(messagesByType(f.doneDir, 'execution_recovery')).toHaveLength(1);
    expect(fsNative.readdirSync(f.pendingDir).filter(n => n.endsWith('.md'))).toHaveLength(0);
    // record 已确认交付（attempt1）
    const record = JSON.parse(fsNative.readFileSync(recordPath(f), 'utf8'));
    expect(record.attempts).toBe(1);
    expect(record.delivery?.kind).toBe('confirmed');
    // 无抑制审计（已到期不抑制）
    expect(scheduleCheckAudits(r.auditEntries)).toHaveLength(0);
  });

  it('用户提前：未来 at 下真实用户消息触达 owner 并实际调用 provider，未生成额外提醒', async () => {
    const f = await makeFixture('quota');
    f.succeed();
    await writeInboxAsync(f.fs, f.pendingDir, {
      id: 'user-early-1',
      type: 'user_inbox_message',
      from: 'user',
      to: CLAW_ID,
      priority: 'normal',
      timestamp: new Date(sharedNow).toISOString(),
      content: 'please continue',
    }, { write: () => {} });

    const r = await runLoop(f);

    // 用户消息触达 owner.begin 获提前资格：真实 provider 调用 +1，消息被消费
    expect(r.processed).toBe(1);
    expect(f.providerCalls()).toBe(2);
    expect(messagesByType(f.doneDir, 'user_inbox_message')).toEqual(['user-early-1']);
    // 未生成额外执行提醒（pending/done 均无 execution_recovery）
    expect(messagesByType(f.pendingDir, 'execution_recovery')).toHaveLength(0);
    expect(messagesByType(f.doneDir, 'execution_recovery')).toHaveLength(0);
    expect(fsNative.existsSync(recordPath(f))).toBe(false);
    // 抑制审计仍留证（新登记被未来 at 挡住，用户消息不受影响）
    expect(scheduleCheckAudits(r.auditEntries)
      .some(e => e.some(col => String(col) === 'reason=llm_retry_scheduled'))).toBe(true);
  });

  it('on_change 新 boot：提醒照常产生工作并真实 begin 准入一次，provider 探测一次', async () => {
    const f = await makeFixture('auth');
    expect((await f.session.inspect()).kind).toBe('on_change');
    f.succeed();

    const r = await runLoop(f);

    // on_change 不被泛化抑制：提醒产生工作 → startup token 获一次准入 → 真实探测
    expect(r.processed).toBe(1);
    expect(f.providerCalls()).toBe(2);
    expect(messagesByType(f.doneDir, 'execution_recovery')).toHaveLength(1);
    expect(scheduleCheckAudits(r.auditEntries)).toHaveLength(0);
  });

  it('已有 pending 义务 + 未来 at：inspect 0 调用，原身份义务继续投递并确认，不实际发请求', async () => {
    const f = await makeFixture('quota');
    // 通过真实 store.save 预置本模块 record（不是手写 owner 状态）：
    // observedActivityAt 必须等于 probe 的 lastActivityAt（不触发 reset）
    const store = createExecutionRecoveryStore({
      agentFs: f.fs,
      legacyRootFs: new NodeFileSystem({ baseDir: f.rootDir }),
      audit: { write: () => {} },
    });
    const scheduledAt = sharedNow - RECOVERY_TIMEOUT_MS;
    store.save({
      schema_version: 1,
      contractId: CONTRACT_ID,
      observedActivityAt: f.activityAt,
      attempts: 1,
      lastAttemptAt: scheduledAt,
      delivery: {
        kind: 'pending',
        id: 'execution_recovery-preserved',
        attempt: 1,
        scheduledAt,
        body: 'preserved body',
      },
    });
    const inspectSpy = vi.spyOn(f.session, 'inspect');

    const r = await runLoop(f);

    // 旧义务不经新检查：inspect 0 调用；义务按原身份投递并真实确认
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(scheduleCheckAudits(r.auditEntries)).toHaveLength(0);
    const record = JSON.parse(fsNative.readFileSync(recordPath(f), 'utf8'));
    expect(record.attempts).toBe(1);
    expect(record.delivery).toMatchObject({
      kind: 'confirmed',
      id: 'execution_recovery-preserved',
      body: 'preserved body',
    });
    // 消息在 pending（owner 未来 at 未准入消费），provider 无新请求
    expect(messagesByType(f.pendingDir, 'execution_recovery'))
      .toEqual(['execution_recovery-preserved']);
    expect(f.providerCalls()).toBe(1);
    expect(r.processed).toBe(0);
    // 正常准入等待流程未被打断：到达 recovery_wait 后由测试 abort 收束
    expect(r.auditEntries.some(e => e.some(col => String(col) === 'type=recovery_wait'))).toBe(true);
  });
});
