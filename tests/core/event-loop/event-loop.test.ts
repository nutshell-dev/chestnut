/**
 * EventLoop unit tests (Phase 783 Step E)
 *
 * 覆盖 EventLoop.run 的调度语义：
 * - context_exceeded → reactive trim → retry → cooldown
 * - chain iteration audit
 * - stream callbacks 透传
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { EventLoop } from '../../../src/core/event-loop/index.js';
import { EVENTLOOP_AUDIT_EVENTS, LOOP_ITERATION_TYPES } from '../../../src/core/event-loop/audit-events.js';
import { LLM_MAX_RETRIES, LLM_RETRY_INITIAL_DELAY_MS } from '../../../src/core/event-loop/constants.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { Runtime, TurnResult } from '../../../src/core/runtime/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { LLMInvalidRequestError, LLMAllProvidersFailedError, LLMAuthError, LLMRateLimitError } from '../../../src/foundation/llm-orchestrator/index.js';
import { LLMContextExceededError } from '../../../src/foundation/llm-orchestrator/errors.js';
import { LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import { MaxStepsExceededError } from '../../../src/core/agent-executor/errors.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import type { InboxHandle, InboxMessage } from '../../../src/foundation/messaging/types.js';

vi.mock('../../../src/core/event-loop/constants.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/event-loop/constants.js')>('../../../src/core/event-loop/constants.js');
  return {
    ...actual,
    LLM_RETRY_INITIAL_DELAY_MS: 10,
    LLM_RETRY_MAX_DELAY_MS: 50,
    // Phase 1268 Step B: cooldown 独立常量，测试用小值锁状态机；
    // Retry-After 截短断言用远大于该值的秒数反向验证。
    LLM_COOLDOWN_MS: 80,
  };
});

function createMockAudit(): AuditLog & { entries: [string, ...(string | number)[]][] } {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => { entries.push([type, ...cols]); },
  };
}

function makeTurnResult(status: TurnResult['status'], extra?: Partial<TurnResult>): TurnResult {
  return { status, ...extra } as TurnResult;
}

describe('EventLoop.run', () => {
  let agentDir: string;
  let inboxPendingDir: string;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `event-loop-test-${randomUUID()}`);
    require('fs').mkdirSync(agentDir, { recursive: true });
    inboxPendingDir = path.join(agentDir, 'inbox', 'pending');
    require('fs').mkdirSync(inboxPendingDir, { recursive: true });
  });

  afterEach(() => {
    require('fs').rmSync(agentDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeEventLoop(runtime: Partial<Runtime>, audit?: AuditLog): EventLoop {
    return new EventLoop({
      runtime: runtime as Runtime,
      fsFactory,
      agentDir,
      clawId: 'test-claw',
      audit: audit ?? createMockAudit(),
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
    });
  }

  function makeEventLoopWithFsOverrides(
    runtime: Partial<Runtime>,
    audit: AuditLog,
    overrides: Partial<FileSystem>,
  ): EventLoop {
    const baseAgentFs = new NodeFileSystem({ baseDir: agentDir });
    const agentFs = new Proxy(baseAgentFs, {
      get(target, prop) {
        if (prop in overrides) {
          return (overrides as Record<string | symbol, unknown>)[prop];
        }
        const value = (target as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as FileSystem;

    const wrappedFsFactory = (dir: string) =>
      path.resolve(dir) === path.resolve(agentDir) ? agentFs : fsFactory(dir);

    return new EventLoop({
      runtime: runtime as Runtime,
      fsFactory: wrappedFsFactory,
      agentDir,
      clawId: 'test-claw',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
    });
  }

  function seedRetryState(count: number, delayMs = LLM_RETRY_INITIAL_DELAY_MS): void {
    const statusDir = path.join(agentDir, 'status');
    require('fs').mkdirSync(statusDir, { recursive: true });
    require('fs').writeFileSync(
      path.join(statusDir, 'llm-retry-state.json'),
      JSON.stringify({ schema_version: 1, llmRetryCount: count, llmRetryDelayMs: delayMs, llmRetryPending: false }),
    );
  }

  function seedBlockedState(state: Record<string, unknown>): void {
    const statusDir = path.join(agentDir, 'status');
    require('fs').mkdirSync(statusDir, { recursive: true });
    require('fs').writeFileSync(
      path.join(statusDir, 'llm-request-blocked-state.json'),
      JSON.stringify(state),
    );
  }

  function seedLegacyBlockedState(state: Record<string, unknown>): void {
    const statusDir = path.join(agentDir, 'status');
    require('fs').mkdirSync(statusDir, { recursive: true });
    require('fs').writeFileSync(
      path.join(statusDir, 'context-blocked-state.json'),
      JSON.stringify(state),
    );
  }

  function readBlockedState(): Record<string, unknown> | undefined {
    const p = path.join(agentDir, 'status', 'llm-request-blocked-state.json');
    if (!require('fs').existsSync(p)) return undefined;
    return JSON.parse(require('fs').readFileSync(p, 'utf-8'));
  }

  function makeContextExceededRuntime(audit: AuditLog, reactiveTrimResult?: unknown) {
    const ctxErr = new LLMContextExceededError('test-provider', 400, 'context length exceeded');
    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: ctxErr }));
    const nackHandles = vi.fn().mockResolvedValue(undefined);
    const reactiveTrim = vi.fn().mockResolvedValue(reactiveTrimResult ?? {
      status: 'no_progress',
      before: 1000,
      after: 1000,
      reason: 'already_within_target',
      newMessages: [],
      archived: false,
    });

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles,
      reactiveTrim,
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    return { runtime, processTurn, nackHandles, reactiveTrim };
  }

  it('MaxStepsExceededError 不再 mutate Contract、仍 ackHandles 破热循环', async () => {
    const audit = createMockAudit();
    const crashErr = new MaxStepsExceededError(10);

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: crashErr }));
    const ackHandles = vi.fn().mockResolvedValue(undefined);
    const nackHandles = vi.fn().mockResolvedValue(undefined);

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [{ metadata: { contract_id: 'test-contract' } }],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles,
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(ackHandles).toHaveBeenCalledWith(['handle-1'], 'agent_loop_crash');
    expect(nackHandles).not.toHaveBeenCalled();
    const fatalEntries = audit.entries.filter(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('agent_loop_crash')),
    );
    expect(fatalEntries.length).toBeGreaterThan(0);
  });

  it('crash error 无 contract_id 时仍 ackHandles、不调用任何 Contract mutation', async () => {
    const audit = createMockAudit();
    const crashErr = new MaxStepsExceededError(10);

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: crashErr }));
    const ackHandles = vi.fn().mockResolvedValue(undefined);
    const nackHandles = vi.fn().mockResolvedValue(undefined);

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles,
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(ackHandles).toHaveBeenCalledWith(['handle-1'], 'agent_loop_crash');
    expect(nackHandles).not.toHaveBeenCalled();
  });

  it('context_exceeded + trim progress 进入 retry 退避，不进入 cooldown 清零周期', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const ctxErr = new LLMContextExceededError('test-provider', 400, 'context length exceeded');

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: ctxErr }));
    const nackHandles = vi.fn().mockResolvedValue(undefined);
    const reactiveTrim = vi.fn().mockResolvedValue({
      status: 'progress',
      before: 1000,
      after: 900,
      newMessages: [],
      archived: true,
    });

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles,
      reactiveTrim,
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);

    for (let i = 0; i < 3; i++) {
      const run = eventLoop.run();
      await vi.advanceTimersByTimeAsync(100);
      await run;
    }

    expect(processTurn).toHaveBeenCalledTimes(3);
    expect(reactiveTrim).toHaveBeenCalledTimes(3);
    expect(nackHandles).toHaveBeenCalledTimes(3);

    const retryEntries = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.LLM_RETRY);
    expect(retryEntries.length).toBe(3);
    expect(audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.COOLDOWN).length).toBe(0);
  });

  it('context_exceeded + trim no_progress 进入 blocked gate，后续 tick 不再 drain/ack/nack', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const ctxErr = new LLMContextExceededError('test-provider', 400, 'context length exceeded');

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: ctxErr }));
    const nackHandles = vi.fn().mockResolvedValue(undefined);
    const reactiveTrim = vi.fn().mockResolvedValue({
      status: 'no_progress',
      before: 1000,
      after: 1000,
      reason: 'already_within_target',
      newMessages: [],
      archived: false,
    });

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles,
      reactiveTrim,
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);

    const run1 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run1;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(reactiveTrim).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED)).toBe(true);

    // 后续 tick：gate blocked，不会 drain/ack/nack/processTurn
    const run2 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run2;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_GATE).length).toBe(1);
  });

  it('chain reaction 触发 eventloop_iteration type=chain', async () => {
    const audit = createMockAudit();
    let drainCall = 0;
    const runtime = {
      drainInbox: vi.fn().mockImplementation(async () => {
        drainCall++;
        if (drainCall === 1) {
          return {
            injected: [{ role: 'user', content: 'a' } as Message, { role: 'user', content: 'b' } as Message],
            sources: [{ text: 'a', type: 'user_chat' }, { text: 'b', type: 'user_chat' }],
            count: 2,
            infos: [] as InboxMessage[],
            addressedHandles: [] as InboxHandle[],
          };
        }
        if (drainCall === 2) {
          return {
            injected: [{ role: 'user', content: 'c' } as Message],
            sources: [{ text: 'c', type: 'user_chat' }],
            count: 1,
            infos: [] as InboxMessage[],
            addressedHandles: [] as InboxHandle[],
          };
        }
        return { injected: [] as Message[], sources: [] as any[], count: 0, infos: [] as InboxMessage[], addressedHandles: [] as InboxHandle[] };
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn: vi.fn().mockResolvedValue(makeTurnResult('success')),
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    const chainEntry = audit.entries.find(e => e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION && e.some(c => String(c).includes(LOOP_ITERATION_TYPES.chain)));
    expect(chainEntry).toBeDefined();
    expect(String(chainEntry!.join('\t'))).toContain('injected=2');
    expect(String(chainEntry!.join('\t'))).toContain('chain_total=3');
  });

  it('claw: per-claw clean-stop marker → skips retry-state load and consumes marker', async () => {
    const audit = createMockAudit();
    const clawAgentDir = path.join(agentDir, 'claws', 'c1');
    require('fs').mkdirSync(clawAgentDir, { recursive: true });
    require('fs').mkdirSync(path.join(clawAgentDir, 'status'), { recursive: true });
    require('fs').writeFileSync(
      path.join(clawAgentDir, 'status', 'llm-retry-state.json'),
      JSON.stringify({ schema_version: 1, llmRetryCount: 7, llmRetryDelayMs: 1000, llmRetryPending: false }),
    );
    require('fs').writeFileSync(path.join(clawAgentDir, 'clean-stop'), String(Date.now()));

    const eventLoop = new EventLoop({
      runtime: { abort: vi.fn() } as unknown as Runtime,
      fsFactory,
      agentDir: clawAgentDir,
      clawId: 'c1',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
    });

    await eventLoop.initialize();

    expect(require('fs').existsSync(path.join(clawAgentDir, 'clean-stop'))).toBe(false);
    const loaded = audit.entries.find(e => e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION && e.some(c => String(c).includes('legacy_pending_ignored')));
    expect(loaded).toBeUndefined();
  });

  it('claw: global clean-stop marker at root → skips retry-state load and consumes marker', async () => {
    const audit = createMockAudit();
    const clawAgentDir = path.join(agentDir, 'claws', 'c1');
    const rootDir = path.dirname(path.dirname(clawAgentDir));
    require('fs').mkdirSync(clawAgentDir, { recursive: true });
    require('fs').mkdirSync(path.join(clawAgentDir, 'status'), { recursive: true });
    require('fs').writeFileSync(
      path.join(clawAgentDir, 'status', 'llm-retry-state.json'),
      JSON.stringify({ schema_version: 1, llmRetryCount: 7, llmRetryDelayMs: 1000, llmRetryPending: false }),
    );
    require('fs').writeFileSync(path.join(rootDir, 'clean-stop'), String(Date.now()));

    const eventLoop = new EventLoop({
      runtime: { abort: vi.fn() } as unknown as Runtime,
      fsFactory,
      agentDir: clawAgentDir,
      clawId: 'c1',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
    });

    await eventLoop.initialize();

    expect(require('fs').existsSync(path.join(rootDir, 'clean-stop'))).toBe(false);
    expect(require('fs').existsSync(path.join(clawAgentDir, 'clean-stop'))).toBe(false);
    const loaded = audit.entries.find(e => e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION && e.some(c => String(c).includes('legacy_pending_ignored')));
    expect(loaded).toBeUndefined();
  });

  it('claw: no marker → loads retry-state', async () => {
    const audit = createMockAudit();
    const clawAgentDir = path.join(agentDir, 'claws', 'c1');
    require('fs').mkdirSync(clawAgentDir, { recursive: true });
    require('fs').mkdirSync(path.join(clawAgentDir, 'status'), { recursive: true });
    require('fs').writeFileSync(
      path.join(clawAgentDir, 'status', 'llm-retry-state.json'),
      JSON.stringify({ schema_version: 1, llmRetryCount: 7, llmRetryDelayMs: 1000, llmRetryPending: true }),
    );

    const eventLoop = new EventLoop({
      runtime: { abort: vi.fn() } as unknown as Runtime,
      fsFactory,
      agentDir: clawAgentDir,
      clawId: 'c1',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
    });

    await eventLoop.initialize();

    const loaded = audit.entries.find(e => e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION && e.some(c => String(c).includes('legacy_pending_ignored')));
    expect(loaded).toBeDefined();
  });

  it('motion: global clean-stop marker → skips retry-state load and consumes marker', async () => {
    const audit = createMockAudit();
    const motionAgentDir = path.join(agentDir, 'motion');
    require('fs').mkdirSync(motionAgentDir, { recursive: true });
    require('fs').mkdirSync(path.join(motionAgentDir, 'status'), { recursive: true });
    require('fs').writeFileSync(
      path.join(motionAgentDir, 'status', 'llm-retry-state.json'),
      JSON.stringify({ schema_version: 1, llmRetryCount: 3, llmRetryDelayMs: 500, llmRetryPending: false }),
    );
    require('fs').writeFileSync(path.join(agentDir, 'clean-stop'), String(Date.now()));

    const eventLoop = new EventLoop({
      runtime: { abort: vi.fn() } as unknown as Runtime,
      fsFactory,
      agentDir: motionAgentDir,
      clawId: 'motion',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
    });

    await eventLoop.initialize();

    expect(require('fs').existsSync(path.join(agentDir, 'clean-stop'))).toBe(false);
    const loaded = audit.entries.find(e => e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION && e.some(c => String(c).includes('legacy_pending_ignored')));
    expect(loaded).toBeUndefined();
  });

  it('streamWriter 存在时 wrapped callbacks 透传给 processTurn', async () => {
    const audit = createMockAudit();
    const streamEvents: Array<{ type: string; [k: string]: unknown }> = [];
    const streamWriter = { write: (ev: { type: string }) => { streamEvents.push(ev); } };

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: [] as InboxHandle[],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn: vi.fn().mockImplementation(async (_m, _s, _t, callbacks?: { onTurnStart?: (sources: any[]) => void; onTurnEnd?: () => void }) => {
        callbacks?.onTurnStart?.([{ text: 'hi', type: 'user_chat' }]);
        callbacks?.onTurnEnd?.();
        return makeTurnResult('success');
      }),
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      getCurrentTraceId: vi.fn().mockReturnValue(undefined),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = new EventLoop({
      runtime: runtime as Runtime,
      fsFactory,
      agentDir,
      clawId: 'test-claw',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
      streamWriter,
    });

    await eventLoop.run();

    expect(streamEvents.length).toBeGreaterThanOrEqual(2);
    expect(streamEvents.some(e => e.type === 'turn_start')).toBe(true);
    expect(streamEvents.some(e => e.type === 'turn_end')).toBe(true);
  });

  it('blocked state write failure keeps in-memory gate and throws to fatal dispatch', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const { runtime, processTurn, nackHandles } = makeContextExceededRuntime(audit);

    const eventLoop = makeEventLoopWithFsOverrides(runtime, audit, {
      writeAtomicSync: vi.fn(() => {
        throw new Error('ENOSPC');
      }),
    });

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED)).toBe(false);
    expect(audit.entries.some(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('saveLlmRequestBlockedState')),
    )).toBe(true);

    // 后续 tick 因内存 gate 仍阻断，不 drain 不调 LLM
    const run2 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run2;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
  });

  it('blocked state delete failure does not release or drain', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    seedBlockedState({
      version: 2,
      reason: 'no_progress',
      requestFingerprint: 'old-fp',
      before: 1000,
      after: 1000,
      blockedAt: new Date().toISOString(),
    });

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn: vi.fn().mockResolvedValue(makeTurnResult('success')),
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('changed-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoopWithFsOverrides(runtime, audit, {
      deleteSync: vi.fn(() => {
        throw new Error('EACCES');
      }),
    });
    await eventLoop.initialize();

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(runtime.drainInbox).not.toHaveBeenCalled();
    expect(runtime.processTurn).not.toHaveBeenCalled();
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_RELEASED)).toBe(false);
    expect(audit.entries.some(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('clearLlmRequestBlockedState')),
    )).toBe(true);
  });

  it('blocked delete ENOENT releases and emits released audit once', async () => {
    const audit = createMockAudit();
    seedBlockedState({
      version: 2,
      reason: 'no_progress',
      requestFingerprint: 'old-fp',
      before: 1000,
      after: 1000,
      blockedAt: new Date().toISOString(),
    });

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('success'));
    let drainCall = 0;
    const runtime = {
      drainInbox: vi.fn().mockImplementation(async () => {
        drainCall++;
        if (drainCall === 1) {
          return {
            injected: [{ role: 'user', content: 'hi' } as Message],
            sources: [{ text: 'hi', type: 'user_chat' }],
            count: 1,
            infos: [] as InboxMessage[],
            addressedHandles: ['handle-1'],
          };
        }
        return { injected: [] as Message[], sources: [] as any[], count: 0, infos: [] as InboxMessage[], addressedHandles: [] as InboxHandle[] };
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('changed-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = new EventLoop({
      runtime: runtime as Runtime,
      fsFactory,
      agentDir,
      clawId: 'test-claw',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
    });
    await eventLoop.initialize();

    // 模拟状态文件在 initialize 之后、run 之前被外部清理；_clearLlmRequestBlockedState 应视为已删除成功
    require('fs').unlinkSync(path.join(agentDir, 'status', 'llm-request-blocked-state.json'));

    await eventLoop.run();

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_RELEASED).length).toBe(1);
  });

  it('retry limit blocks current failed request before another trim', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    seedRetryState(LLM_MAX_RETRIES);
    const { runtime, processTurn, reactiveTrim } = makeContextExceededRuntime(audit);

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.initialize();

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(reactiveTrim).not.toHaveBeenCalled();
    expect(processTurn).toHaveBeenCalledTimes(1);
    const blocked = readBlockedState();
    expect(blocked).toBeDefined();
    expect(blocked!.reason).toBe('retry_exhausted');
    expect(blocked!.attempts).toBe(LLM_MAX_RETRIES);
    expect(blocked!.maxAttempts).toBe(LLM_MAX_RETRIES);
  });

  it('restarts recover retry_exhausted blocked state and time does not release it', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    seedBlockedState({
      version: 2,
      reason: 'retry_exhausted',
      requestFingerprint: 'stable-fp',
      attempts: LLM_MAX_RETRIES,
      maxAttempts: LLM_MAX_RETRIES,
      blockedAt: new Date().toISOString(),
    });

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('success'));
    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('stable-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.initialize();

    // 300s 推进不会解除 blocked
    const run1 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(300_000);
    await run1;

    expect(processTurn).not.toHaveBeenCalled();
    expect(audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_GATE).length).toBe(1);

    // 再次 run 仍 blocked
    const run2 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(300_000);
    await run2;

    expect(processTurn).not.toHaveBeenCalled();
    expect(audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_GATE).length).toBe(2);
  });

  it('LLMInvalidRequestError enters request blocked gate and blocks same fingerprint ticks', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const invalidErr = new LLMInvalidRequestError('openai', 'invalid_unicode', '$.messages[0].content', 5);

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: invalidErr }));
    const nackHandles = vi.fn().mockResolvedValue(undefined);

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('bad-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);

    const run1 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run1;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(audit.entries.some(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED && e.some(c => String(c).includes('invalid_request')),
    )).toBe(true);

    const blocked = readBlockedState();
    expect(blocked).toMatchObject({ version: 2, reason: 'invalid_request', errorCode: 'LLM_INVALID_REQUEST', requestFingerprint: 'bad-fp' });

    const run2 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run2;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_GATE).length).toBe(1);
  });

  it('LLMAllProvidersFailedError with all invalid_request enters request blocked gate', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const allInvalidErr = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMInvalidRequestError('openai', 'invalid_unicode') },
      { provider: 'anthropic', error: new LLMInvalidRequestError('anthropic', 'invalid_unicode') },
    ]);

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: allInvalidErr }));
    const nackHandles = vi.fn().mockResolvedValue(undefined);

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('all-invalid-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
    const blocked = readBlockedState();
    expect(blocked).toMatchObject({ version: 2, reason: 'invalid_request', requestFingerprint: 'all-invalid-fp' });
  });

  it('LLMAuthError enters request blocked gate with permanent_provider_error reason', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const authErr = new LLMAuthError('custom-anthropic', 401, 'Authentication Fails, Your api key is invalid');

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: authErr }));
    const nackHandles = vi.fn().mockResolvedValue(undefined);

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('auth-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);

    const run1 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run1;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);

    const blocked = readBlockedState();
    expect(blocked).toMatchObject({
      version: 2,
      reason: 'permanent_provider_error',
      userActionHint: 'rotate_api_key',
      requestFingerprint: 'auth-fp',
    });

    // Blocked gate must suspend retries on the same fingerprint.
    const run2 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run2;
    expect(processTurn).toHaveBeenCalledTimes(1);
  });

  it('LLMAllProvidersFailedError with all auth failures enters request blocked gate', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const allAuthErr = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMAuthError('openai', 401, 'bad key') },
      { provider: 'anthropic', error: new LLMAuthError('anthropic', 401, 'bad key') },
    ]);

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: allAuthErr }));
    const nackHandles = vi.fn().mockResolvedValue(undefined);

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('all-auth-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
    const blocked = readBlockedState();
    expect(blocked).toMatchObject({
      version: 2,
      reason: 'permanent_provider_error',
      userActionHint: 'rotate_api_key',
      requestFingerprint: 'all-auth-fp',
    });
  });

  it('LLMAllProvidersFailedError with transient nested errors triggers retry, not blocked gate', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const transientErr = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMNetworkError('openai', new Error('ECONNREFUSED')) },
      { provider: 'anthropic', error: new LLMNetworkError('anthropic', new Error('ECONNREFUSED')) },
    ]);

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: transientErr }));
    const nackHandles = vi.fn().mockResolvedValue(undefined);

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('transient-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(readBlockedState()).toBeUndefined();
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.LLM_RETRY)).toBe(true);
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED)).toBe(false);
  });

  it('LLMRateLimitError with retryAfter triggers backoff retry, not blocked gate', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const rateLimitErr = new LLMRateLimitError('openai', 30);

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: rateLimitErr }));
    const nackHandles = vi.fn().mockResolvedValue(undefined);

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('rate-limit-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(readBlockedState()).toBeUndefined();
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.LLM_RETRY)).toBe(true);
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED)).toBe(false);
  });

  it('LLMAllProvidersFailedError with all rate_limit failures triggers retry', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const allRateLimitErr = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMRateLimitError('openai', 5) },
      { provider: 'anthropic', error: new LLMRateLimitError('anthropic', 15) },
    ]);

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: allRateLimitErr }));
    const nackHandles = vi.fn().mockResolvedValue(undefined);

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('all-rate-limit-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(readBlockedState()).toBeUndefined();
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.LLM_RETRY)).toBe(true);
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED)).toBe(false);
  });

  it('legacy v1 context-blocked-state.json is migrated to v2 llm-request-blocked-state.json', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    seedLegacyBlockedState({
      version: 1,
      reason: 'no_progress',
      requestFingerprint: 'legacy-fp',
      before: 1000,
      after: 1000,
      blockedAt: new Date().toISOString(),
    });

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('success'));
    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('legacy-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.initialize();

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(processTurn).not.toHaveBeenCalled();
    const blocked = readBlockedState();
    expect(blocked).toMatchObject({ version: 2, reason: 'no_progress', requestFingerprint: 'legacy-fp' });
    expect(require('fs').existsSync(path.join(agentDir, 'status', 'context-blocked-state.json'))).toBe(false);
  });

  function makePostDrainRuntime(
    overrides: Partial<{
      getSystemPrompt: () => Promise<string>;
      getMessages: () => Promise<Message[]>;
      proactiveTrimIfNeeded: (messages: Message[]) => Promise<Message[]>;
      processTurn: () => Promise<TurnResult>;
      onTurnStartError: boolean;
    }>,
  ) {
    const ackHandles = vi.fn().mockResolvedValue(undefined);
    const nackHandles = vi.fn().mockResolvedValue(undefined);
    const processTurn = vi.fn().mockImplementation(overrides.processTurn ?? (async () => makeTurnResult('success')));

    const runtime = {
      drainInbox: vi.fn().mockResolvedValue({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      getSystemPrompt: overrides.getSystemPrompt ?? vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: overrides.getMessages ?? vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: overrides.proactiveTrimIfNeeded ?? vi.fn().mockImplementation((m: Message[]) => Promise.resolve(m)),
      processTurn,
      ackHandles,
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;

    return { runtime, ackHandles, nackHandles, processTurn };
  }

  it('post-drain: getSystemPrompt reject -> nack once with stage=system_prompt, processTurn=0', async () => {
    const audit = createMockAudit();
    const systemPromptError = new Error('system prompt failed');
    const { runtime, nackHandles, processTurn } = makePostDrainRuntime({
      getSystemPrompt: () => Promise.reject(systemPromptError),
    });

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(processTurn).not.toHaveBeenCalled();
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledWith(['handle-1'], 'system prompt failed', 'post_drain_failure');
    expect(audit.entries.some(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.POST_DRAIN_FAILURE_RECOVERED && e.some(c => String(c).includes('stage=system_prompt')),
    )).toBe(true);
  });

  it('post-drain: getMessages reject -> nack once with stage=session_messages', async () => {
    const audit = createMockAudit();
    const messagesError = new Error('messages failed');
    const { runtime, nackHandles, processTurn } = makePostDrainRuntime({
      getMessages: () => Promise.reject(messagesError),
    });

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(processTurn).not.toHaveBeenCalled();
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledWith(['handle-1'], 'messages failed', 'post_drain_failure');
    expect(audit.entries.some(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.POST_DRAIN_FAILURE_RECOVERED && e.some(c => String(c).includes('stage=session_messages')),
    )).toBe(true);
  });

  it('post-drain: proactiveTrimIfNeeded reject -> nack once with stage=proactive_trim', async () => {
    const audit = createMockAudit();
    const trimError = new Error('proactive trim failed');
    const { runtime, nackHandles, processTurn } = makePostDrainRuntime({
      proactiveTrimIfNeeded: () => Promise.reject(trimError),
    });

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(processTurn).not.toHaveBeenCalled();
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledWith(['handle-1'], 'proactive trim failed', 'post_drain_failure');
    expect(audit.entries.some(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.POST_DRAIN_FAILURE_RECOVERED && e.some(c => String(c).includes('stage=proactive_trim')),
    )).toBe(true);
  });

  it('post-drain: onTurnStart throw -> nack once with stage=turn_start_callback', async () => {
    const audit = createMockAudit();
    const { runtime, nackHandles, processTurn } = makePostDrainRuntime({});
    // streamWriter 存在时 wrappedCallbacks.onTurnStart 会调用 runtime.getCurrentTraceId；
    // 未提供则抛出，模拟 turn_start_callback 阶段异常。
    const eventLoop = new EventLoop({
      runtime: runtime as Runtime,
      fsFactory,
      agentDir,
      clawId: 'test-claw',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
      streamWriter: { write: vi.fn() },
    });
    await eventLoop.run();

    expect(processTurn).not.toHaveBeenCalled();
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledWith(['handle-1'], expect.stringContaining('getCurrentTraceId'), 'post_drain_failure');
    expect(audit.entries.some(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.POST_DRAIN_FAILURE_RECOVERED && e.some(c => String(c).includes('stage=turn_start_callback')),
    )).toBe(true);
  });

  it('post-drain: processTurn reject -> nack once with stage=process_turn', async () => {
    const audit = createMockAudit();
    const turnError = new Error('process turn failed');
    const { runtime, nackHandles } = makePostDrainRuntime({
      processTurn: () => Promise.reject(turnError),
    });

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledWith(['handle-1'], 'process turn failed', 'post_drain_failure');
    expect(audit.entries.some(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.POST_DRAIN_FAILURE_RECOVERED && e.some(c => String(c).includes('stage=process_turn')),
    )).toBe(true);
  });

  it('post-drain: resolved failed TurnResult -> nack once with rollback path, no recovery audit', async () => {
    const audit = createMockAudit();
    const turnError = new Error('turn failed');
    const { runtime, nackHandles } = makePostDrainRuntime({
      processTurn: () => Promise.resolve(makeTurnResult('failed', { error: turnError })),
    });

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledWith(['handle-1'], 'turn failed', 'rollback');
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.POST_DRAIN_FAILURE_RECOVERED)).toBe(false);
  });

  it('post-drain: success -> ack once, nack=0', async () => {
    const audit = createMockAudit();
    const { runtime, ackHandles, nackHandles, processTurn } = makePostDrainRuntime({});

    let drainCall = 0;
    (runtime as any).drainInbox = vi.fn().mockImplementation(async () => {
      drainCall++;
      if (drainCall === 1) {
        return {
          injected: [{ role: 'user', content: 'hi' } as Message],
          sources: [{ text: 'hi', type: 'user_chat' }],
          count: 1,
          infos: [] as InboxMessage[],
          addressedHandles: ['handle-1'],
        };
      }
      return { injected: [] as Message[], sources: [] as any[], count: 0, infos: [] as InboxMessage[], addressedHandles: [] as InboxHandle[] };
    });

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(ackHandles).toHaveBeenCalledTimes(1);
    expect(ackHandles).toHaveBeenCalledWith(['handle-1'], 'normal_turn_end');
    expect(nackHandles).not.toHaveBeenCalled();
  });

  // ----- Phase 1268 Step B: recoverable LLM 持久 retry waiting / cooldown 状态机 -----

  function makeRecoverableRuntime(
    error: Error,
    fingerprint: string,
    processTurnImpl?: () => Promise<TurnResult>,
  ) {
    // pending 模拟真实 inbox：nack 后消息仍在，ack 后才排空，避免 success 后 chain 空转。
    const inbox = { pending: true };
    const processTurn = vi.fn().mockImplementation(
      processTurnImpl ?? (async () => makeTurnResult('failed', { error })),
    );
    const nackHandles = vi.fn().mockResolvedValue(undefined);
    const ackHandles = vi.fn().mockImplementation(async () => { inbox.pending = false; });
    const computeTurnRequestFingerprint = vi.fn().mockResolvedValue(fingerprint);
    const runtime = {
      drainInbox: vi.fn().mockImplementation(async () => {
        if (!inbox.pending) {
          return { injected: [] as Message[], sources: [] as any[], count: 0, infos: [] as InboxMessage[], addressedHandles: [] as InboxHandle[] };
        }
        return {
          injected: [{ role: 'user', content: 'hi' } as Message],
          sources: [{ text: 'hi', type: 'user_chat' }],
          count: 1,
          infos: [] as InboxMessage[],
          addressedHandles: ['handle-1'],
        };
      }),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles,
      nackHandles,
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint,
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [], controls: [] }),
    } as unknown as Runtime;
    return { runtime, processTurn, nackHandles, ackHandles, computeTurnRequestFingerprint };
  }

  function readRetryState(): Record<string, unknown> | undefined {
    const p = path.join(agentDir, 'status', 'llm-retry-state.json');
    if (!require('fs').existsSync(p)) return undefined;
    return JSON.parse(require('fs').readFileSync(p, 'utf-8'));
  }

  const retryScheduled = (audit: ReturnType<typeof createMockAudit>) =>
    audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.LLM_RETRY && e.some(c => String(c) === 'action=scheduled'));
  const cooldownScheduled = (audit: ReturnType<typeof createMockAudit>) =>
    audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.COOLDOWN && e.some(c => String(c) === 'action=scheduled'));

  it('持续 rate-limit 超预算进入 cooldown：count 保持 max，不重开完整 retry 周期', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const rateLimitErr = new LLMRateLimitError('openai');
    const { runtime, processTurn } = makeRecoverableRuntime(rateLimitErr, 'rl-fp');

    const eventLoop = makeEventLoop(runtime, audit);

    // 4 次失败：3 次普通 retry 后第 4 次进入 cooldown（schedule 无 sleep，run1 不需 advance）
    await eventLoop.run();
    // 决定等待即先落盘：第一次失败后文件已含 waiting，无等待完成
    const savedAfterFirst = readRetryState();
    expect(savedAfterFirst).toMatchObject({ schema_version: 2, llmRetryCount: 1 });
    expect(savedAfterFirst!.waiting).toMatchObject({ kind: 'retry', attempt: 1, maxAttempts: 3, requestFingerprint: 'rl-fp' });
    for (let i = 1; i < 4; i++) {
      const run = eventLoop.run();
      await vi.advanceTimersByTimeAsync(100);
      await run;
    }

    expect(processTurn).toHaveBeenCalledTimes(4);
    expect(retryScheduled(audit).length).toBe(3);
    expect(cooldownScheduled(audit).length).toBe(1);
    const saved = readRetryState();
    expect(saved!.llmRetryCount).toBe(3);  // 不清零
    expect(saved!.waiting).toMatchObject({ kind: 'cooldown', attempts: 3, maxAttempts: 3 });

    // cooldown 到期仅一次 probe；probe 失败再次 cooldown，仍不重开周期
    const run5 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run5;

    expect(processTurn).toHaveBeenCalledTimes(5);
    expect(retryScheduled(audit).length).toBe(3);  // 无新的普通 retry
    expect(cooldownScheduled(audit).length).toBe(2);
    expect(readRetryState()!.llmRetryCount).toBe(3);
  });

  it('cooldown probe 成功走既有 success reset：预算与 waiting 归零', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const rateLimitErr = new LLMRateLimitError('openai');
    let call = 0;
    const { runtime, processTurn, ackHandles } = makeRecoverableRuntime(rateLimitErr, 'rl-fp', async () => {
      call++;
      return call >= 5 ? makeTurnResult('success') : makeTurnResult('failed', { error: rateLimitErr });
    });

    const eventLoop = makeEventLoop(runtime, audit);

    await eventLoop.run();
    for (let i = 1; i < 5; i++) {
      const run = eventLoop.run();
      await vi.advanceTimersByTimeAsync(100);
      await run;
    }

    expect(processTurn).toHaveBeenCalledTimes(5);
    expect(ackHandles).toHaveBeenCalledWith(['handle-1'], 'normal_turn_end');
    const saved = readRetryState();
    expect(saved!.llmRetryCount).toBe(0);
    expect(saved!.llmRetryDelayMs).toBe(10);  // mocked LLM_RETRY_INITIAL_DELAY_MS
    expect(saved!.waiting).toBeNull();
  });

  it('restart 恢复持久 waiting：早于 resumeAt 不调 LLM，到期才放行', async () => {
    vi.useFakeTimers();
    const audit1 = createMockAudit();
    const rateLimitErr = new LLMRateLimitError('openai');
    const { runtime: runtime1, processTurn: processTurn1 } = makeRecoverableRuntime(rateLimitErr, 'rl-fp');

    const eventLoop1 = makeEventLoop(runtime1, audit1);
    await eventLoop1.run();  // schedule 无 sleep，fake clock 不动，resumeAt 仍在未来
    expect(processTurn1).toHaveBeenCalledTimes(1);

    // 模拟进程重启：新 EventLoop 从磁盘恢复 waiting（resumeAt = schedule 时 + 10ms）
    const audit2 = createMockAudit();
    const { runtime: runtime2, processTurn: processTurn2 } = makeRecoverableRuntime(rateLimitErr, 'rl-fp');
    const eventLoop2 = makeEventLoop(runtime2, audit2);
    await eventLoop2.initialize();

    const run2 = eventLoop2.run();
    await vi.advanceTimersByTimeAsync(5);  // 未到 resumeAt
    expect(processTurn2).not.toHaveBeenCalled();
    expect(audit2.entries.some(e => e.some(c => String(c) === 'action=gated'))).toBe(true);

    await vi.advanceTimersByTimeAsync(100);  // 越过 resumeAt
    await run2;
    expect(processTurn2).toHaveBeenCalledTimes(1);
  });

  it('abort mid-retry 不清 waiting：磁盘保留已决定的等待供恢复', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const rateLimitErr = new LLMRateLimitError('openai');
    const { runtime, processTurn } = makeRecoverableRuntime(rateLimitErr, 'rl-fp');

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();  // schedule 无 sleep，fake clock 不动

    const before = readRetryState()!.waiting as Record<string, unknown>;

    const run2 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(5);  // gate 等待中（resumeAt=schedule+10ms）
    eventLoop.abort();
    await run2;

    expect(processTurn).toHaveBeenCalledTimes(1);  // 未放行新 turn
    expect(readRetryState()!.waiting).toEqual(before);  // waiting 未被清除
  });

  it('fingerprint 变化释放 waiting 并重置预算，按新事实执行', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const rateLimitErr = new LLMRateLimitError('openai');
    const { runtime, processTurn, computeTurnRequestFingerprint } = makeRecoverableRuntime(rateLimitErr, 'fp-A');

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();
    expect(readRetryState()!.llmRetryCount).toBe(1);

    // 新消息/配置导致 fingerprint 改变 → 释放 waiting、重置预算、立即执行
    computeTurnRequestFingerprint.mockResolvedValue('fp-B');
    processTurn.mockImplementation(async () => makeTurnResult('success'));
    const run2 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(5);  // 不等到原 resumeAt 即放行
    await run2;

    expect(processTurn).toHaveBeenCalledTimes(2);
    expect(audit.entries.some(e => e.some(c => String(c) === 'action=released'))).toBe(true);
    const saved = readRetryState();
    expect(saved!.llmRetryCount).toBe(0);
    expect(saved!.waiting).toBeNull();
  });

  it('cooldown 不被 backoff cap 截短：服务端更长 Retry-After 按秒数等待', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    seedRetryState(LLM_MAX_RETRIES);  // v1 文件迁移 count=3（预算已耗尽）
    const rateLimitErr = new LLMRateLimitError('openai', 400);  // 400s > 300s cap
    const { runtime, processTurn } = makeRecoverableRuntime(rateLimitErr, 'rl-fp');

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.initialize();

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(cooldownScheduled(audit).length).toBe(1);
    expect(cooldownScheduled(audit)[0].some(c => String(c) === 'cooldown_ms=400000')).toBe(true);
    const waiting = readRetryState()!.waiting as Record<string, unknown>;
    expect(Date.parse(waiting.resumeAt as string) - Date.parse(waiting.scheduledAt as string)).toBe(400_000);
  });

  it('cooldown 聚合 Retry-After 取最早合法时间；无 header 用独立默认 cooldown', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    seedRetryState(LLM_MAX_RETRIES);
    const aggregateErr = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMRateLimitError('openai', 400) },
      { provider: 'anthropic', error: new LLMRateLimitError('anthropic', 15) },
    ]);
    const { runtime } = makeRecoverableRuntime(aggregateErr, 'rl-fp');

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.initialize();

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(cooldownScheduled(audit)[0].some(c => String(c) === 'cooldown_ms=15000')).toBe(true);

    // 无 header → 独立默认 cooldown（mocked LLM_COOLDOWN_MS=80），不是 backoff cap 50
    const audit2 = createMockAudit();
    seedRetryState(LLM_MAX_RETRIES);
    const { runtime: runtime2 } = makeRecoverableRuntime(new LLMRateLimitError('openai'), 'rl-fp');
    const eventLoop2 = makeEventLoop(runtime2, audit2);
    await eventLoop2.initialize();
    const run2 = eventLoop2.run();
    await vi.advanceTimersByTimeAsync(100);
    await run2;
    expect(cooldownScheduled(audit2)[0].some(c => String(c) === 'cooldown_ms=80')).toBe(true);
  });

  it('v1 retry-state 迁移：count/delay 保留并接入新 waiting 状态机', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    seedRetryState(2, 30);  // v1 文件：count=2, delayMs=30
    const rateLimitErr = new LLMRateLimitError('openai');
    const { runtime } = makeRecoverableRuntime(rateLimitErr, 'rl-fp');

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.initialize();

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    // 迁移后的 count=2 → 本次失败是第 3 次普通 retry
    const scheduled = retryScheduled(audit);
    expect(scheduled.length).toBe(1);
    expect(scheduled[0].some(c => String(c) === 'attempt=3')).toBe(true);
    expect(scheduled[0].some(c => String(c) === 'delay_ms=30')).toBe(true);
    expect(readRetryState()!.waiting).toMatchObject({ kind: 'retry', attempt: 3 });
  });

  it('Phase 1268 Step D: waiting 调度写结构化 llm_retry_waiting stream 事件（scheduled/gated/released）', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const streamEvents: Array<Record<string, unknown>> = [];
    const streamWriter = { write: (ev: Record<string, unknown>) => { streamEvents.push(ev); } };
    const rateLimitErr = new LLMRateLimitError('openai');
    const { runtime, computeTurnRequestFingerprint } = makeRecoverableRuntime(rateLimitErr, 'fp-A');
    // streamWriter 存在时 wrapped callbacks.onTurnStart 需要 getCurrentTraceId
    (runtime as any).getCurrentTraceId = vi.fn().mockReturnValue(undefined);

    const eventLoop = new EventLoop({
      runtime: runtime as Runtime,
      fsFactory,
      agentDir,
      clawId: 'test-claw',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
      streamWriter,
    });

    // scheduled：失败后立即写（决定等待即落盘 + stream）
    await eventLoop.run();
    const scheduled = streamEvents.filter(e => e.type === 'llm_retry_waiting');
    expect(scheduled.length).toBe(1);
    expect(scheduled[0]).toMatchObject({
      stage: 'retry',
      action: 'scheduled',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorClass: 'rate_limit',
    });
    expect(typeof scheduled[0].resumeAt).toBe('string');
    expect(typeof scheduled[0].ts).toBe('number');

    // gated：下一 tick deadline 未到先 gated
    const run2 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run2;
    const gated = streamEvents.filter(e => e.type === 'llm_retry_waiting' && e.action === 'gated');
    expect(gated.length).toBeGreaterThanOrEqual(1);
    expect(gated[0]).toMatchObject({ stage: 'retry', attempt: 1, maxAttempts: 3 });

    // released：fingerprint 变化
    streamEvents.length = 0;
    computeTurnRequestFingerprint.mockResolvedValue('fp-B');
    const run3 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run3;
    const released = streamEvents.filter(e => e.type === 'llm_retry_waiting' && e.action === 'released');
    expect(released.length).toBe(1);
    expect(released[0]).toMatchObject({ stage: 'retry', action: 'released' });
  });

  it('clean-stop 跳过 retry-state load（现有语义保留）：waiting 不恢复', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    // 手写 v2 waiting 文件 + clean-stop marker
    const statusDir = path.join(agentDir, 'status');
    require('fs').mkdirSync(statusDir, { recursive: true });
    require('fs').writeFileSync(
      path.join(statusDir, 'llm-retry-state.json'),
      JSON.stringify({
        schema_version: 2,
        llmRetryCount: 2,
        llmRetryDelayMs: 30,
        llmRetryPending: false,
        waiting: {
          kind: 'retry',
          requestFingerprint: 'rl-fp',
          errorClass: 'rate_limit',
          attempt: 2,
          maxAttempts: 3,
          scheduledAt: new Date().toISOString(),
          resumeAt: new Date(Date.now() + 60_000).toISOString(),
          error: 'rate limited',
        },
      }),
    );
    require('fs').writeFileSync(path.join(agentDir, 'clean-stop'), String(Date.now()));

    const { runtime, processTurn } = makeRecoverableRuntime(new LLMRateLimitError('openai'), 'rl-fp');
    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.initialize();

    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(5);  // 不 gated，立即 drain
    await run;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(audit.entries.some(e => e.some(c => String(c) === 'action=gated'))).toBe(false);
  });
});
