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
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { RELOAD_LLM_CONFIG_MESSAGE_TYPE } from '../../../src/core/runtime/inbox-message-types.js';
import { LLMAuthError } from '../../../src/foundation/llm-provider/errors.js';
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
    LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS: 500,
    LLM_RECOVERY_RETRY_INITIAL_DELAY_MS: 500,
    LLM_RECOVERY_COOLDOWN_MS: 500,
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
  /** 让接下来的 N 次干预事实读取抛错（测读取失败不以空集合继续准入）。 */
  setInterventionPeekFailures: (n: number) => void;
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
  let peekFailures = 0;

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
      if (peekFailures > 0) {
        peekFailures -= 1;
        throw new Error('inbox peek failed');
      }
      const view = await inboxReader.peekPending();
      return {
        userIds: view.entries
          .filter(e => e.message.type === 'user_chat' || e.message.type === 'user_inbox_message')
          .map(e => e.message.id),
      };
    },
    consumePendingControls: async () => ({ consumed: 0 }),
    // Phase 1847: 真实 Messaging 驱动返回原批次（消息+句柄），format 单独生成注入数据
    prepareInbox: async () => {
      const result = await inboxReader.drainAndDeliver();
      const handleByPath = new Map(result.handles.map(h => [h.filePath, h]));
      return {
        entries: result.entries.map(e => ({
          message: e.message,
          handle: handleByPath.get(e.filePath)!,
        })),
      };
    },
    formatPreparedInbox: async (batch: { entries: ReadonlyArray<{ message: InboxMessage }> }) => ({
      injected: batch.entries.map(e => ({ role: 'user' as const, content: e.message.content })),
      sources: batch.entries.map(e => ({ text: e.message.content, type: e.message.type })),
      count: batch.entries.length,
      infos: batch.entries.map(e => e.message),
    }),
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
    setInterventionPeekFailures: (n) => { peekFailures = n; },
  };
}

const QUOTA_ERROR = () => new Error('insufficient quota');

// ---------------------------------------------------------------------------
// Phase 1827: Z5 组合回归——真实 EventLoop + 真实 Messaging + 真实 owner
// + 真实 Runtime.consumePendingControls（配置提供者 fake、provider 计数假实现）。
// ---------------------------------------------------------------------------

/** 只用于注入依赖字段的 Runtime 子类（绕过 initialize，与 inbox-reload-intercept 同法）。 */
class ComboRuntime extends Runtime {
  injectForTest(opts: { inboxReader: unknown; auditWriter: unknown; llm: unknown }) {
    (this as unknown as Record<string, unknown>).inboxReader = opts.inboxReader;
    (this as unknown as Record<string, unknown>).auditWriter = opts.auditWriter;
    (this as unknown as Record<string, unknown>).llm = opts.llm;
  }
}

interface RuntimeHarness {
  eventLoop: EventLoop;
  session: LLMRecoverySession;
  providerCalls: string[];
  turns: Array<Array<{ role: string; content: string }>>;
  emitted: LLMEvent[];
  reloadCalls: () => number;
  writePending: (msg: { id: string; type: string; from: string; content: string }) => void;
  writeReload: () => void;
  listPending: () => string[];
  setProviderError: (error: Error | undefined) => void;
}

async function makeRuntimeHarness(): Promise<RuntimeHarness> {
  const dir = await createTrackedTempDir('llm-recovery-runtime-combo-');
  cleanupDirs.push(dir);
  const fs = new NodeFileSystem({ baseDir: dir });
  const inboxDir = path.join(dir, 'inbox');
  const pendingDir = path.join(inboxDir, 'pending');
  fsNative.mkdirSync(pendingDir, { recursive: true });

  const audit = { write: () => { /* not under test */ } };
  const inboxReader = new InboxReader(
    pendingDir,
    path.join(inboxDir, 'done'),
    path.join(inboxDir, 'failed'),
    fs,
    audit as never,
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
  const orchestrator = createLLMOrchestrator({
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
    orchestrator,
  });

  // 配置提供者（fake）：返回不同身份的 primary → 新配置修订；应用时假装换上可用 key。
  let reloadCalls = 0;
  const fixedConfig = {
    primary: { name: 'primary-fixed', apiKey: 'key-fixed', model: 'model-primary', temperature: 0, timeoutMs: 1_000, apiFormat: 'anthropic' as const },
    maxAttempts: 1,
    retryDelayMs: 1,
    events: sink,
  };

  const runtimeLlm = {
    reloadConfig: (cfg: unknown) => {
      reloadCalls += 1;
      providerError = undefined;   // 修好 key：重新加载后不再按旧错误失败
      orchestrator.reloadConfig({ ...(cfg as never), createAnthropicAdapter: () => adapter });
    },
  };

  const runtime = new ComboRuntime({
    clawId: 'claw-1',
    clawDir: dir,
    idleTimeoutMs: 0,
    llmConfig: { primary: { name: 'primary', apiKey: 'key-primary', model: 'model-primary', temperature: 0, timeoutMs: 1_000, apiFormat: 'anthropic' as const }, maxAttempts: 1, retryDelayMs: 1 },
    configReloader: () => fixedConfig as never,
    dependencies: {
      auditWriter: audit,
      inboxReader,
      llm: runtimeLlm,
      toolRegistry: { register: () => {}, getForProfile: () => [], getAll: () => [], formatForLLM: () => [] },
    },
  } as never);
  runtime.injectForTest({ inboxReader, auditWriter: audit, llm: runtimeLlm });

  const turns: RuntimeHarness['turns'] = [];
  const runtimeAny = runtime as unknown as Record<string, unknown>;
  runtimeAny.computeTurnRequestFingerprint = async () => 'fp-combo';
  // Phase 1847: 真实 Messaging 驱动返回原批次（reload 控制消息仍在此拦截并 ack），
  // format 单独生成原注入数据。
  runtimeAny.prepareInbox = async () => {
    const result = await inboxReader.drainAndDeliver();
    const reloadEntries = result.entries.filter(e => e.message.type === RELOAD_LLM_CONFIG_MESSAGE_TYPE);
    for (const entry of reloadEntries) {
      const handle = result.handles.find(h => h.filePath === entry.filePath);
      if (handle) await inboxReader.ack(handle);
    }
    const addressed = result.entries.filter(e => e.message.type !== RELOAD_LLM_CONFIG_MESSAGE_TYPE);
    const handleByPath = new Map(result.handles.map(h => [h.filePath, h]));
    return {
      entries: addressed.map(e => ({
        message: e.message,
        handle: handleByPath.get(e.filePath)!,
      })),
    };
  };
  runtimeAny.formatPreparedInbox = async (batch: { entries: ReadonlyArray<{ message: InboxMessage }> }) => ({
    injected: batch.entries.map(e => ({ role: 'user' as const, content: e.message.content })),
    sources: batch.entries.map(e => ({ text: e.message.content, type: e.message.type })),
    count: batch.entries.length,
    infos: batch.entries.map(e => e.message),
  });
  runtimeAny.getMessages = async () => [];
  runtimeAny.getSystemPrompt = async () => 'sys';
  runtimeAny.getToolsForLLM = () => [];
  runtimeAny.proactiveTrimIfNeeded = async (m: unknown[]) => m;
  runtimeAny.reactiveTrim = async () => { throw new Error('reactiveTrim not expected'); };
  runtimeAny.processTurn = async (messages: Array<{ role: string; content: string }>) => {
    turns.push(messages.map(m => ({ role: m.role, content: m.content })));
    try {
      await session.llm.call({ messages: [{ role: 'user', content: 'turn' }] });
      return { status: 'success' as const };
    } catch (error) {
      return { status: 'failed' as const, error };
    }
  };

  const writeMessage = (msg: { id: string; type: string; from: string; content: string }) => {
    fsNative.writeFileSync(path.join(pendingDir, `${msg.id}.md`), encodeInbox({
      id: msg.id,
      type: msg.type,
      from: msg.from,
      to: 'claw-1',
      content: msg.content,
      priority: 'normal',
      timestamp: new Date().toISOString(),
    } as InboxMessage));
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
    providerCalls,
    turns,
    emitted,
    reloadCalls: () => reloadCalls,
    writePending: writeMessage,
    writeReload: () => writeMessage({
      id: 'reload-1',
      type: RELOAD_LLM_CONFIG_MESSAGE_TYPE,
      from: 'cli',
      content: 'reload',
    }),
    listPending: () => fsNative.readdirSync(pendingDir).filter(n => n.endsWith('.md')),
    setProviderError: (error) => { providerError = error; },
  };
}

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
    await sleep(30);   // < 500ms deadline
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
    await sleep(30);   // < 500ms deadline
    expect(h.providerCalls.length).toBe(1);
    const after = await h.session.inspect();
    expect(after.kind).toBe('at');
    // 系统消息不清零失败历史、不重置 deadline（墙钟到点后 revision 可前进，
    // 但同一 resumeAt 保持——系统消息本身不改变安排）。
    if (after.kind === 'at' && scheduleBefore.kind === 'at') {
      expect(after.resumeAt).toBe(scheduleBefore.resumeAt);
    }
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

    // 等到 deadline（500ms 缩放值）后由 EventLoop 自动放行一次。
    h.setProviderError(undefined);
    const rerun = h.eventLoop.run();
    await sleep(650);
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
    await sleep(30);
    h.writePending({ id: 'm-2', type: 'user_chat', from: 'user', content: 'second' });
    await sleep(600);   // 跨过 deadline 与唤醒处理

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
    await sleep(30);
    expect(h.providerCalls.length).toBe(2);
    h.eventLoop.abort();
    await rerun;
  });
});

describe('Phase 1827 事实读取失败处理', () => {
  it('读取失败：不以空集合继续准入；等待后重读、按真实事实准入一次', async () => {
    const h = await makeHarness();
    h.writePending({ id: 'm-1', type: 'user_chat', from: 'user', content: 'hello' });

    // 持续失败窗口：不得用空集合绕过（否则会立即准入并真发）。
    h.setInterventionPeekFailures(Number.POSITIVE_INFINITY);
    const running = h.eventLoop.run();
    await sleep(120);   // > fallbackTimeoutMs(30)：若空集合继续准入，这里已经真发
    expect(h.providerCalls.length).toBe(0);
    expect(h.turns.length).toBe(0);

    // 读取恢复：重读拿到真实用户事实，正常准入一次。
    h.setInterventionPeekFailures(0);
    await sleep(150);
    expect(h.providerCalls.length).toBe(1);
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].map(m => m.content)).toEqual(['hello']);
    h.eventLoop.abort();
    await running;
  });
});

describe('Phase 1827 Z5 组合回归：真实 Runtime 控制入口 × EventLoop × owner', () => {
  it('pending 旧用户 + 真实配置修订同时到达：不被旧消息遮蔽，发起第二次真实请求', async () => {
    const h = await makeRuntimeHarness();
    h.setProviderError(new LLMAuthError('primary', 401, 'invalid api key'));
    h.writePending({ id: 'old-user', type: 'user_chat', from: 'user', content: 'hello' });

    // 第一次：permanent 失败 → 安排 on_change；旧用户 id 已被接受记账。
    await h.eventLoop.run();
    expect(h.providerCalls.length).toBe(1);
    expect((await h.session.inspect()).kind).toBe('on_change');
    expect(h.listPending()).toContain('old-user.md');

    // 用户修好配置：reload 控制消息落盘；真实 consumePendingControls 应用并返回新修订。
    h.writeReload();
    const running = h.eventLoop.run();
    await sleep(150);
    h.eventLoop.abort();
    await running;

    // Z5：旧用户 id 不遮蔽配置事实 → 一次恢复准入 → 第二次真实请求。
    expect(h.providerCalls.length).toBe(2);
    expect(h.reloadCalls()).toBe(1);

    // 接受证据：同一批事实里配置修订与旧用户身份都可关联。
    const accepted = h.emitted.filter(e => e.type === 'recovery_facts_accepted');
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    const batch = accepted.at(-1);
    expect(batch).toMatchObject({ scope: 'foreground' });
    if (batch?.type === 'recovery_facts_accepted') {
      expect(typeof batch.configurationRevision).toBe('string');
      expect(batch.attemptId).toBeTruthy();
    }
    // 准入主原因就是配置事实（不是旧用户、不是启动 token）——旧消息确实没有遮蔽配置。
    const admittedEvents = h.emitted.filter(e => e.type === 'recovery_attempt_admitted');
    expect(admittedEvents.at(-1)).toMatchObject({ trigger: 'configuration' });
    h.eventLoop.abort();
  });

  it('重复配置修订：不重复应用配置，也不重复接受记账', async () => {
    const h = await makeRuntimeHarness();
    h.setProviderError(new LLMAuthError('primary', 401, 'invalid api key'));
    h.writePending({ id: 'old-user', type: 'user_chat', from: 'user', content: 'hello' });
    await h.eventLoop.run();
    expect(h.providerCalls.length).toBe(1);

    h.writeReload();
    const firstRun = h.eventLoop.run();
    await sleep(150);
    h.eventLoop.abort();
    await firstRun;
    const reloadsAfterFirst = h.reloadCalls();
    const acceptedAfterFirst = h.emitted.filter(e => e.type === 'recovery_facts_accepted').length;
    expect(reloadsAfterFirst).toBe(1);

    // 同一 reload 消息仍在 pending（正常 drain 才消费一次）+ 同一配置身份重送 → 不再 reload。
    const secondRun = h.eventLoop.run();
    await sleep(150);
    h.eventLoop.abort();
    await secondRun;
    expect(h.reloadCalls()).toBe(reloadsAfterFirst);
    expect(h.emitted.filter(e => e.type === 'recovery_facts_accepted').length)
      .toBe(acceptedAfterFirst);
  });
});
