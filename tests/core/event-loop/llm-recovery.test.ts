/**
 * Phase 1826 组合行为：真实 EventLoop + 真实 messaging inbox 消费 + owner session
 * + 记录真实 provider 请求次数的假 provider。
 *
 * 断言目标（计划 §6.2 行为矩阵）：
 * - 用户提前输入：未到 deadline 也发起一次尝试，旧消息与新消息进入同一真实 turn；
 * - 失败回队的同一消息不重复获得提前尝试资格；
 * - 系统消息到达不清零历史、不提前真发；
 * - deadline 到期自动放行；
 * - 子代理（非 scoped 调用）成功不清前台等待。
 *
 * 计时：恢复 delay 常量在本文件缩到毫秒级（不靠真实分钟 sleep）；墙钟用真实时间，
 * 断言前用短窗口观察「未到点」行为。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fsNative from 'fs';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { InboxReader } from '../../../src/foundation/messaging/index.js';
import { encodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import type { InboxMessage } from '../../../src/foundation/messaging/index.js';
import { EventLoop } from '../../../src/core/event-loop/index.js';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { createRecoverySession } from '../../../src/foundation/llm-orchestrator/index.js';
import type {
  LLMEvent,
  LLMEventSink,
  LLMOrchestratorOwner,
  LLMRecoverySession,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/index.js';
import type { ProviderAdapter, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';

// 恢复 delay 缩到毫秒（timed-wait 语义不变，长度可测）。
vi.mock('../../../src/foundation/llm-orchestrator/defaults.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/llm-orchestrator/defaults.js')>();
  return {
    ...actual,
    LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS: 80,
    LLM_RECOVERY_RETRY_INITIAL_DELAY_MS: 80,
    LLM_RECOVERY_COOLDOWN_MS: 80,
  };
});

const OK_RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
};

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    try { await cleanupTempDir(dir); } catch { /* ignore */ }
  }
});

interface Harness {
  eventLoop: EventLoop;
  session: LLMRecoverySession;
  /** 非 scoped 的 owner 实例（子代理等 callers 的路径）。 */
  sharedOrchestrator: LLMOrchestratorOwner;
  providerCalls: string[];
  turns: Array<Array<{ role: string; content: string }>>;
  emitted: LLMEvent[];
  writePending: (msg: Partial<InboxMessage> & { type: string; from: string; content: string }) => void;
  listPending: () => string[];
  setProviderError: (error: Error | undefined) => void;
}

async function makeHarness(): Promise<Harness> {
  const dir = await createTrackedTempDir('llm-recovery-combo-');
  cleanupDirs.push(dir);
  const fs = new NodeFileSystem({ baseDir: dir });
  const inboxDir = path.join(dir, 'inbox');
  const pendingDir = path.join(inboxDir, 'pending');
  fsNative.mkdirSync(pendingDir, { recursive: true });

  const auditSink = { write: () => { /* messaging audit not under test */ } };
  const inboxReader = new InboxReader(
    pendingDir,
    path.join(inboxDir, 'done'),
    path.join(inboxDir, 'failed'),
    fs,
    auditSink as never,
    path.join(inboxDir, 'inflight'),
  );
  await inboxReader.init();

  const providerCalls: string[] = [];
  let providerError: Error | undefined;
  const adapter: ProviderAdapter = {
    name: 'primary',
    model: 'model-primary',
    call: async () => {
      providerCalls.push('primary');
      if (providerError) throw providerError;
      return OK_RESPONSE;
    },
    stream: async function* () { throw new Error('stream unused in this suite'); },
  };

  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = { emit: (e) => { emitted.push(e); } };
  const sharedOrchestrator = createLLMOrchestrator({
    primary: providerConfig(),
    maxAttempts: 1,
    retryDelayMs: 1,
    events: sink,
    createAnthropicAdapter: () => adapter,
  });
  const session = createRecoverySession({
    scopeId: 'foreground',
    fs,
    events: sink,
    orchestrator: sharedOrchestrator,
  });

  const turns: Harness['turns'] = [];

  const runtime = {
    abort: () => {},
    getCurrentTraceId: () => undefined,
    ackHandles: async (handles: Array<{ filePath: string; originalFileName: string }>) => {
      for (const h of handles) await inboxReader.ack(h as never);
    },
    nackHandles: async (handles: Array<{ filePath: string; originalFileName: string }>) => {
      for (const h of handles) await inboxReader.nack(h as never, 'test');
    },
    computeTurnRequestFingerprint: async () => 'fp-combo',
    peekPendingTurnFacts: async () => {
      const view = await inboxReader.peekPending();
      return { addressed: view.entries.map(e => e.message), controls: [] };
    },
    peekPendingInterventionFacts: async () => {
      const view = await inboxReader.peekPending();
      return {
        userIds: view.entries
          .filter(e => e.message.type === 'user_chat' || e.message.type === 'user_inbox_message')
          .map(e => e.message.id),
      };
    },
    consumePendingControls: async () => ({ consumed: 0 }),
    drainInbox: async () => {
      const result = await inboxReader.drainAndDeliver();
      const addressedSet = new Set(result.entries.map(e => e.filePath));
      const handles = result.handles.filter(h => addressedSet.has(h.filePath));
      return {
        injected: result.entries.map(e => ({ role: 'user' as const, content: e.message.content })),
        sources: result.entries.map(e => ({ text: e.message.content, type: e.message.type })),
        count: result.entries.length,
        infos: result.entries.map(e => e.message),
        addressedHandles: handles,
      };
    },
    getMessages: async () => [],
    getSystemPrompt: async () => 'sys',
    getToolsForLLM: () => [],
    proactiveTrimIfNeeded: async (m: unknown[]) => m,
    // 组合要点：turn 内的真实 LLM 调用走 owner 的 scoped 视图 —— 假 provider
    // 的请求计数即真实请求计数，失败/成功经 owner 策略回流到 EventLoop 的调度。
    processTurn: async (messages: Array<{ role: string; content: string }>) => {
      turns.push(messages.map(m => ({ role: m.role, content: m.content })));
      try {
        await session.llm.call({ messages: [{ role: 'user', content: 'turn' }] });
        return { status: 'success' as const };
      } catch (error) {
        return { status: 'failed' as const, error };
      }
    },
    reactiveTrim: async () => {
      throw new Error('reactiveTrim not expected in these tests');
    },
  };

  const eventLoop = new EventLoop({
    runtime: runtime as never,
    fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }),
    agentDir: dir,
    clawId: 'claw-1',
    audit: { write: () => {} } as never,
    inbox: { pendingDir, fallbackTimeoutMs: 30 },
    recovery: session,
  });
  await eventLoop.initialize();

  return {
    eventLoop,
    session,
    sharedOrchestrator,
    providerCalls,
    turns,
    emitted,
    writePending: (msg) => {
      const full: InboxMessage = {
        id: msg.id ?? `msg-${Math.random().toString(16).slice(2)}`,
        type: msg.type,
        from: msg.from,
        to: msg.to ?? 'claw-1',
        content: msg.content,
        priority: msg.priority ?? 'normal',
        timestamp: msg.timestamp ?? new Date().toISOString(),
      };
      fsNative.writeFileSync(path.join(pendingDir, `${full.id}.md`), encodeInbox(full));
    },
    listPending: () => fsNative.readdirSync(pendingDir).filter(n => n.endsWith('.md')),
    setProviderError: (error) => { providerError = error; },
  };
}

const QUOTA_ERROR = () => new Error('insufficient quota');

describe('Phase 1826 组合行为：owner 安排 × EventLoop 执行 × 真实 inbox', () => {
  it('用户提前输入：未到 deadline 发起一次尝试，旧消息与新消息进入同一真实 turn', async () => {
    const h = await makeHarness();
    h.setProviderError(QUOTA_ERROR());

    // 旧消息：首次尝试失败后回队（nack → 仍在 pending）。
    h.writePending({ id: 'm-old', type: 'user_chat', from: 'user', content: 'old instruction' });
    await h.eventLoop.run();
    expect(h.providerCalls.length).toBe(1);
    expect(h.listPending()).toContain('m-old.md');
    expect((await h.session.inspect()).kind).toBe('at');

    // 第二条真新用户消息到达：提前尝试（不等 deadline）。
    h.writePending({ id: 'm-new', type: 'user_chat', from: 'user', content: 'new instruction' });
    await h.eventLoop.run();

    expect(h.providerCalls.length).toBe(2);
    expect(h.turns.length).toBe(2);
    expect(h.turns[1].map(m => m.content)).toEqual(['old instruction', 'new instruction']);

    // 同一批消息失败回队后不重复放行：未到点的短窗口内不再真发。
    const rerun = h.eventLoop.run();
    await sleep(20);   // < 80ms deadline
    expect(h.providerCalls.length).toBe(2);
    h.eventLoop.abort();
    await rerun;
  });

  it('系统消息到达：不清零失败历史、不提前真发', async () => {
    const h = await makeHarness();
    h.setProviderError(QUOTA_ERROR());

    h.writePending({ id: 'm-1', type: 'user_chat', from: 'user', content: 'hello' });
    await h.eventLoop.run();
    expect(h.providerCalls.length).toBe(1);
    const scheduleBefore = await h.session.inspect();
    expect(scheduleBefore.kind).toBe('at');

    // 系统消息（任务结果）到达：保存为 pending，不触发提前尝试。
    h.writePending({ id: 's-1', type: 'task_result', from: 'system', content: 'task done' });
    const rerun = h.eventLoop.run();
    await sleep(20);   // < 80ms deadline
    expect(h.providerCalls.length).toBe(1);
    expect(await h.session.inspect()).toEqual(scheduleBefore);
    expect(h.listPending()).toEqual(expect.arrayContaining(['m-1.md', 's-1.md']));
    h.eventLoop.abort();
    await rerun;
  });

  it('deadline 到期：自动发起下一次真实尝试（timed wait 执行）', async () => {
    const h = await makeHarness();
    h.setProviderError(QUOTA_ERROR());

    h.writePending({ id: 'm-1', type: 'user_chat', from: 'user', content: 'hello' });
    await h.eventLoop.run();
    expect(h.providerCalls.length).toBe(1);

    // 等到 deadline（80ms 缩放值）后由 EventLoop 自动放行一次。
    h.setProviderError(undefined);
    const rerun = h.eventLoop.run();
    await sleep(120);
    expect(h.providerCalls.length).toBe(2);
    h.eventLoop.abort();
    await rerun;
  });

  it('用户消息与定时器同时到达：一次准入、一次 turn、一次真发', async () => {
    const h = await makeHarness();
    h.setProviderError(QUOTA_ERROR());

    h.writePending({ id: 'm-1', type: 'user_chat', from: 'user', content: 'first' });
    await h.eventLoop.run();
    expect(h.providerCalls.length).toBe(1);
    expect(h.turns.length).toBe(1);

    // 新一轮 run 在等待 deadline；期间用户新消息到达（唤醒）→ 重新准入一次，
    // 不允许同时产生第二个并发 turn。
    const rerun = h.eventLoop.run();
    await sleep(20);
    h.writePending({ id: 'm-2', type: 'user_chat', from: 'user', content: 'second' });
    await sleep(120);   // 跨过 deadline 与唤醒处理

    expect(h.providerCalls.length).toBe(2);   // 只多一次真实尝试
    expect(h.turns.length).toBe(2);           // 只多一个 turn
    expect(h.turns[1].map(m => m.content)).toEqual(['first', 'second']);
    h.eventLoop.abort();
    await rerun;
  });

  it('子代理（非 scoped 调用）成功不清前台等待', async () => {
    const h = await makeHarness();
    h.setProviderError(QUOTA_ERROR());

    h.writePending({ id: 'm-1', type: 'user_chat', from: 'user', content: 'hello' });
    await h.eventLoop.run();
    expect(h.providerCalls.length).toBe(1);
    const waiting = await h.session.inspect();
    expect(waiting.kind).toBe('at');

    // 另一 caller 直接用共享 owner 实例调用（子代理路径）并成功。
    h.setProviderError(undefined);
    await h.sharedOrchestrator.call({ messages: [{ role: 'user', content: 'subagent work' }] });
    expect(h.providerCalls.length).toBe(2);

    // 前台等待安排未被外部成功改变：仍未到点（短窗口内不追加请求）。
    expect(await h.session.inspect()).toEqual(waiting);
    const rerun = h.eventLoop.run();
    await sleep(20);
    expect(h.providerCalls.length).toBe(2);
    h.eventLoop.abort();
    await rerun;
  });
});
