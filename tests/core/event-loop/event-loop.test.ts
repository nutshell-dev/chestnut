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
import { CONTEXT_TRIM_RETRY_MAX, CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS, EXECUTION_RECOVERY_DELIVERY_META_KEY } from '../../../src/core/event-loop/constants.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { Runtime, TurnResult } from '../../../src/core/runtime/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/index.js';
import { LLMContextExceededError } from '../../../src/foundation/llm-provider/index.js';
import { LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import { MaxStepsExceededError } from '../../../src/core/agent-executor/errors.js';
import type { ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { InboxHandle, InboxMessage } from '../../../src/foundation/messaging/types.js';
import { decodeInbox, encodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { writeInboxAsync } from '../../../src/foundation/messaging/index.js';

vi.mock('../../../src/core/event-loop/constants.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/event-loop/constants.js')>('../../../src/core/event-loop/constants.js');
  return {
    ...actual,
    UNKNOWN_ERROR_RECOVERY_DELAY_MS: 10,
    // Phase 1826: trim 后有界重试用小值锁状态机（10→20→40，cap 50）。
    CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS: 10,
    CONTEXT_TRIM_RETRY_MAX_DELAY_MS: 50,
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

/** Phase 1847: 旧 drainInbox mock 形状（迁移期局部表达，不进入生产类型）。 */
interface LegacyDrainBatch {
  injected: Message[];
  sources: Array<{ text: string; type: string }>;
  /** 旧 mock 中 infos 元素允许是不完整对象（原 mockResolvedValue 不校验形状）。 */
  infos: unknown[];
  addressedHandles: unknown[];
}

/** 旧批次 → 原消息/同一 handles 的 PreparedInboxBatch.entries。 */
function legacyBatchEntries(batch: LegacyDrainBatch) {
  return batch.injected.map((injected, i) => ({
    message: (batch.infos[i] as InboxMessage | undefined) ?? ({
      id: `mock-${i}`,
      type: batch.sources[i]?.type ?? 'user_chat',
      from: 'mock',
      to: '',
      content: typeof injected.content === 'string' ? injected.content : '',
      priority: 'normal',
      timestamp: new Date(0).toISOString(),
    } as InboxMessage),
    handle: (batch.addressedHandles[i] ?? `handle-auto-${i}`) as InboxHandle,
  }));
}

/** Phase 1847: prepare 返回原消息/同一 handles，format 返回原期望注入内容。 */
function mockInboxBoundary(batch: LegacyDrainBatch) {
  return {
    prepareInbox: vi.fn().mockResolvedValue({ entries: legacyBatchEntries(batch) }),
    formatPreparedInbox: vi.fn().mockResolvedValue({
      injected: batch.injected,
      sources: batch.sources,
      count: batch.injected.length,
      infos: batch.infos as InboxMessage[],
    }),
  };
}

/** Phase 1847: 按序返回非空批次、耗尽后返回空批次（对齐旧 drainInbox mockImplementation 语义）。 */
function mockSequentialInboxBoundary(batches: LegacyDrainBatch[]) {
  const empty: LegacyDrainBatch = { injected: [], sources: [], infos: [], addressedHandles: [] };
  let call = 0;
  let current = empty;
  return {
    prepareInbox: vi.fn().mockImplementation(async () => {
      current = call < batches.length ? batches[call] : empty;
      call++;
      return { entries: legacyBatchEntries(current) };
    }),
    formatPreparedInbox: vi.fn().mockImplementation(async () => ({
      injected: current.injected,
      sources: current.sources,
      count: current.injected.length,
      infos: current.infos as InboxMessage[],
    })),
  };
}

/** Phase 1847: 空批次 mock（EventLoop 永不进入 format/turn）。 */
function mockEmptyInboxBoundary() {
  return mockInboxBoundary({ injected: [], sources: [], infos: [], addressedHandles: [] });
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


  function makeMockRecovery() {
    const adoptLegacy = vi.fn().mockReturnValue({ kind: 'imported' });
    const begin = vi.fn().mockResolvedValue({ kind: 'admitted', attemptId: 'att-test', factsAccepted: true });
    const finish = vi.fn().mockResolvedValue(undefined);
    const inspect = vi.fn().mockResolvedValue({ kind: 'ready', revision: 1 });
    return { controller: { inspect, begin, finish, adoptLegacy }, adoptLegacy, begin, finish, inspect };
  }

  function makeEventLoop(
    runtime: Partial<Runtime>,
    audit?: AuditLog,
    recovery?: import('../../../src/foundation/llm-orchestrator/index.js').LLMRecoveryController,
  ): EventLoop {
    return new EventLoop({
      runtime: runtime as Runtime,
      fsFactory,
      agentDir,
      clawId: 'test-claw',
      audit: audit ?? createMockAudit(),
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
      ...(recovery ? { recovery } : {}),
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

  function seedRetryState(count: number, delayMs = CONTEXT_TRIM_RETRY_INITIAL_DELAY_MS): void {
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
      ...mockInboxBoundary({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
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
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
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
      ...mockInboxBoundary({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
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
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
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
      ...mockInboxBoundary({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
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
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
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
      ...mockInboxBoundary({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
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
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
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
      ...mockInboxBoundary({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
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
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
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
    const runtime = {
      ...mockSequentialInboxBoundary([
        {
          injected: [{ role: 'user', content: 'a' } as Message, { role: 'user', content: 'b' } as Message],
          sources: [{ text: 'a', type: 'user_chat' }, { text: 'b', type: 'user_chat' }],
          infos: [] as InboxMessage[],
          addressedHandles: [] as InboxHandle[],
        },
        {
          injected: [{ role: 'user', content: 'c' } as Message],
          sources: [{ text: 'c', type: 'user_chat' }],
          infos: [] as InboxMessage[],
          addressedHandles: [] as InboxHandle[],
        },
      ]),
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
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
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

    const recovery = makeMockRecovery();
    const eventLoop = new EventLoop({
      runtime: { abort: vi.fn() } as unknown as Runtime,
      fsFactory,
      agentDir: clawAgentDir,
      clawId: 'c1',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
      recovery: recovery.controller,
    });

    await eventLoop.initialize();

    // Phase 1826: 旧恢复状态由 EventLoop（旧 owner）导出、owner 幂等导入。
    expect(recovery.adoptLegacy).toHaveBeenCalledTimes(1);
    const exported = recovery.adoptLegacy.mock.calls[0][0];
    expect(exported.source).toBe('llm-retry-state.json@v1');
    expect(exported.retryCount).toBe(7);
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
      ...mockInboxBoundary({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
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
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
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
      ...mockInboxBoundary({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
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
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
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

    expect(runtime.prepareInbox).not.toHaveBeenCalled();
    expect(runtime.processTurn).not.toHaveBeenCalled();
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_RELEASED)).toBe(false);
    expect(audit.entries.some(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('clearLlmRequestBlockedState')),
    )).toBe(true);
  });

  it('phase 1778 startup probe: blocked cleared at initialize (ENOENT-tolerant delete), first run drains, startup_probe audit once', async () => {
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
    const runtime = {
      ...mockSequentialInboxBoundary([
        {
          injected: [{ role: 'user', content: 'hi' } as Message],
          sources: [{ text: 'hi', type: 'user_chat' }],
          infos: [] as InboxMessage[],
          addressedHandles: ['handle-1'],
        },
      ]),
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
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
    } as unknown as Runtime;

    // deleteSync 一律 ENOENT：模拟状态文件在 initialize 清除前已被外部清理——
    // ENOENT 视为已清除（既有容忍语义），启动探测照常放行首轮 drain。
    const eventLoop = makeEventLoopWithFsOverrides(runtime, audit, {
      deleteSync: vi.fn(() => {
        const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
    });
    await eventLoop.initialize();

    await eventLoop.run();

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_STARTUP_PROBE).length).toBe(1);
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_RELEASED)).toBe(false);
  });

  it('retry limit blocks current failed request before another trim', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const { runtime, processTurn, reactiveTrim } = makeContextExceededRuntime(audit, {
      status: 'progress',
      before: 1000,
      after: 900,
      newMessages: [],
      archived: true,
    });

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.initialize();

    // Phase 1826: trim 预算为 EventLoop 自有内存预算（不再读写 llm-retry-state.json）。
    for (let i = 0; i < CONTEXT_TRIM_RETRY_MAX; i++) {
      const run = eventLoop.run();
      await vi.advanceTimersByTimeAsync(100);
      await run;
    }
    expect(reactiveTrim).toHaveBeenCalledTimes(CONTEXT_TRIM_RETRY_MAX);
    expect(readBlockedState()).toBeUndefined();

    // 预算耗尽后的下一次失败：不再 trim，直接进入 retry_exhausted blocked。
    const run = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(processTurn).toHaveBeenCalledTimes(CONTEXT_TRIM_RETRY_MAX + 1);
    expect(reactiveTrim).toHaveBeenCalledTimes(CONTEXT_TRIM_RETRY_MAX);
    const blocked = readBlockedState();
    expect(blocked).toBeDefined();
    expect(blocked!.reason).toBe('retry_exhausted');
    expect(blocked!.attempts).toBe(CONTEXT_TRIM_RETRY_MAX);
    expect(blocked!.maxAttempts).toBe(CONTEXT_TRIM_RETRY_MAX);
  });

  it('phase 1778 startup probe: restart clears blocked（干预信号）→ 同 fingerprint 首轮 probe 成功 ack、blocked 不再现', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    seedBlockedState({
      version: 2,
      reason: 'retry_exhausted',
      requestFingerprint: 'stable-fp',
      attempts: CONTEXT_TRIM_RETRY_MAX,
      maxAttempts: CONTEXT_TRIM_RETRY_MAX,
      blockedAt: new Date().toISOString(),
    });

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('success'));
    const ackHandles = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      ...mockSequentialInboxBoundary([
        {
          injected: [{ role: 'user', content: 'hi' } as Message],
          sources: [{ text: 'hi', type: 'user_chat' }],
          infos: [] as InboxMessage[],
          addressedHandles: ['handle-1'],
        },
      ]),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles,
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      // 同 provider 换 key / 配额恢复场景：fingerprint 不变（释放条件不满足，1778 前只能删文件）
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('stable-fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.initialize();

    // 启动探测：blocked 已清除（同指纹也不再 fail-closed）+ audit 记录 + 文件落盘删除
    expect(audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_STARTUP_PROBE).length).toBe(1);
    expect(readBlockedState()).toBeUndefined();

    const run1 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run1;

    // 首轮正常 drain probe：恢复已生效 → 成功 ack，无 gate 阻断
    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(ackHandles).toHaveBeenCalledWith(['handle-1'], 'normal_turn_end');
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_GATE)).toBe(false);
  });

  it('provider 类旧 blocked 在 initialize 交接给 owner（文件删除、不双写）', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    seedBlockedState({
      version: 2,
      reason: 'permanent_provider_error',
      requestFingerprint: 'stable-fp',
      userActionHint: null,
      message: 'provider auth error (stale)',
      blockedAt: new Date().toISOString(),
    });
    const recovery = makeMockRecovery();
    const { runtime } = makeContextExceededRuntime(audit);
    const eventLoop = makeEventLoop(runtime, audit, recovery.controller);

    await eventLoop.initialize();

    // Phase 1826: provider 类阻断（invalid_request / permanent_provider_error）归 owner；
    // EventLoop 作为旧 owner 导出后删除旧文件（禁止双写），不再持有该 gate。
    expect(recovery.adoptLegacy).toHaveBeenCalledTimes(1);
    const exported = recovery.adoptLegacy.mock.calls[0][0];
    expect(exported.source).toBe('llm-request-blocked-state.json@v2');
    expect(exported.blocked).toMatchObject({
      reason: 'permanent_provider_error',
      requestFingerprint: 'stable-fp',
    });
    expect(readBlockedState()).toBeUndefined();
    // provider 类不触发 trim 类 blocked 的启动探测语义
    expect(
      audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_STARTUP_PROBE).length,
    ).toBe(0);
  });

  it('phase 1778 startup probe: 无 blocked 启动不受影响（无探测 audit、行为不变）', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('success'));
    const runtime = {
      ...mockSequentialInboxBoundary([
        {
          injected: [{ role: 'user', content: 'hi' } as Message],
          sources: [{ text: 'hi', type: 'user_chat' }],
          infos: [] as InboxMessage[],
          addressedHandles: ['handle-1'],
        },
      ]),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp-1'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.initialize();

    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.CONTEXT_BLOCKED_STARTUP_PROBE)).toBe(false);

    const run1 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(100);
    await run1;

    expect(processTurn).toHaveBeenCalledTimes(1);
  });

  function makePostDrainRuntime(
    overrides: Partial<{
      getSystemPrompt: () => Promise<string>;
      getMessages: () => Promise<Message[]>;
      proactiveTrimIfNeeded: (messages: Message[]) => Promise<Message[]>;
      processTurn: () => Promise<TurnResult>;
      /** Phase 1847: 覆盖 prepare/format 边界（format 失败、中断注入）。 */
      prepareInbox: () => Promise<unknown>;
      formatPreparedInbox: (batch: unknown) => Promise<unknown>;
      onTurnStartError: boolean;
    }>,
  ) {
    const ackHandles = vi.fn().mockResolvedValue(undefined);
    const nackHandles = vi.fn().mockResolvedValue(undefined);
    const processTurn = vi.fn().mockImplementation(overrides.processTurn ?? (async () => makeTurnResult('success')));

    const runtime = {
      ...mockInboxBoundary({
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      }),
      ...(overrides.prepareInbox ? { prepareInbox: overrides.prepareInbox } : {}),
      ...(overrides.formatPreparedInbox ? { formatPreparedInbox: overrides.formatPreparedInbox } : {}),
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
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
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

    // 首轮非空批次、后续空批次（对齐旧 drainInbox 后赋值语义）
    Object.assign(runtime as unknown as Record<string, unknown>, mockSequentialInboxBoundary([
      {
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        infos: [] as InboxMessage[],
        addressedHandles: ['handle-1'],
      },
    ]));

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(ackHandles).toHaveBeenCalledTimes(1);
    expect(ackHandles).toHaveBeenCalledWith(['handle-1'], 'normal_turn_end');
    expect(nackHandles).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Phase 1847: 原始批次交接 —— format 失败与中断的 EventLoop 处置
  // ---------------------------------------------------------------------------

  it('post-drain: formatPreparedInbox reject -> nack once with stage=inbox_format, processTurn=0', async () => {
    const audit = createMockAudit();
    const formatError = new Error('formatter rejected');
    const formatPreparedInbox = vi.fn().mockRejectedValue(formatError);
    const { runtime, ackHandles, nackHandles, processTurn } = makePostDrainRuntime({
      formatPreparedInbox,
    });

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(formatPreparedInbox).toHaveBeenCalledTimes(1);
    expect(processTurn).not.toHaveBeenCalled();
    expect(ackHandles).not.toHaveBeenCalled();
    // 全批一次 nack（禁止外层/内层重复）
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledWith(['handle-1'], 'formatter rejected', 'post_drain_failure');
    expect(audit.entries.some(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.POST_DRAIN_FAILURE_RECOVERED && e.some(c => String(c).includes('stage=inbox_format')),
    )).toBe(true);
  });

  it('post-drain: prepare 后、format 前停止 -> nack interrupted_before_injection（format/LLM 均零调用）', async () => {
    const audit = createMockAudit();
    let loop: EventLoop | undefined;
    const formatPreparedInbox = vi.fn().mockResolvedValue({
      injected: [], sources: [], count: 0, infos: [] as InboxMessage[],
    });
    const { runtime, ackHandles, nackHandles, processTurn } = makePostDrainRuntime({
      formatPreparedInbox: formatPreparedInbox as unknown as (batch: unknown) => Promise<unknown>,
    });
    // prepare 返回原批次后同步中断：format 前检查必须截停
    (runtime as unknown as { prepareInbox: unknown }).prepareInbox = vi.fn().mockImplementation(async () => {
      const batch = {
        entries: [{ message: { id: 'm-1' } as unknown as InboxMessage, handle: 'handle-1' as unknown as InboxHandle }],
      };
      loop!.abort();
      return batch;
    });

    loop = makeEventLoop(runtime, audit);
    await loop.run();

    expect(formatPreparedInbox).not.toHaveBeenCalled();
    expect(processTurn).not.toHaveBeenCalled();
    expect(ackHandles).not.toHaveBeenCalled();
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledWith(['handle-1'], 'interrupted_before_injection', 'before_injection');
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.POST_DRAIN_FAILURE_RECOVERED)).toBe(false);
  });

  it('post-drain: format 成功后、processTurn 前停止 -> nack interrupted_before_injection（不 ack 为完成）', async () => {
    const audit = createMockAudit();
    let loop: EventLoop | undefined;
    const formatPreparedInbox = vi.fn().mockImplementation(async () => {
      loop!.abort();
      return {
        injected: [{ role: 'user', content: 'hi' } as Message],
        sources: [{ text: 'hi', type: 'user_chat' }],
        count: 1,
        infos: [] as InboxMessage[],
      };
    });
    const { runtime, ackHandles, nackHandles, processTurn } = makePostDrainRuntime({
      formatPreparedInbox: formatPreparedInbox as unknown as (batch: unknown) => Promise<unknown>,
    });

    loop = makeEventLoop(runtime, audit);
    await loop.run();

    expect(formatPreparedInbox).toHaveBeenCalledTimes(1);
    expect(processTurn).not.toHaveBeenCalled();
    expect(ackHandles).not.toHaveBeenCalled();
    expect(nackHandles).toHaveBeenCalledTimes(1);
    expect(nackHandles).toHaveBeenCalledWith(['handle-1'], 'interrupted_before_injection', 'before_injection');
  });
});

describe('EventLoop execution recovery (phase 1396 Step E)', () => {
  let baseDir: string;
  let agentDir: string;
  let inboxPendingDir: string;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  const CONTRACT_ID = '1700000000000-stall';
  const RECOVERY_TIMEOUT_MS = 1000;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    baseDir = path.join(os.tmpdir(), `event-loop-recovery-test-${randomUUID()}`);
    // agentDir 形如 <base>/claws/<clawId>：Phase 1841 起 record 落本 claw 本地
    // （<agentDir>/event-loop/execution-recovery/），<base> 旧目录仅只读继承。
    agentDir = path.join(baseDir, 'claws', 'test-claw');
    require('fs').mkdirSync(agentDir, { recursive: true });
    inboxPendingDir = path.join(agentDir, 'inbox', 'pending');
    require('fs').mkdirSync(inboxPendingDir, { recursive: true });
  });

  afterEach(() => {
    require('fs').rmSync(baseDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeIdleRuntime(): Runtime {
    return {
      ...mockEmptyInboxBoundary(),
      getSystemPrompt: vi.fn().mockResolvedValue('sys'),
      getToolsForLLM: vi.fn().mockReturnValue([] as ToolDefinition[]),
      getMessages: vi.fn().mockResolvedValue([] as Message[]),
      proactiveTrimIfNeeded: vi.fn().mockImplementation((m: Message[]) => m),
      processTurn: vi.fn(),
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      computeTurnRequestFingerprint: vi.fn().mockResolvedValue('fp'),
      peekPendingTurnFacts: vi.fn().mockResolvedValue({ addressed: [{ id: 'pending-1' } as InboxMessage], controls: [] }),
      peekPendingInterventionFacts: vi.fn().mockResolvedValue({ userIds: [] }),
      consumePendingControls: vi.fn().mockResolvedValue({ consumed: 0 }),
    } as unknown as Runtime;
  }

  function makeRecoveryEventLoop(
    runtime: Runtime,
    audit: AuditLog,
    recovery: {
      probeActivity: () => Promise<{ activeContractId?: string; lastActivityAt: number | null }>;
      isAsyncTaskInFlight?: () => Promise<boolean>;
    },
  ): EventLoop {
    return new EventLoop({
      runtime,
      fsFactory,
      agentDir,
      clawId: 'test-claw',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
      executionRecovery: { ...recovery, timeoutMs: RECOVERY_TIMEOUT_MS },
    });
  }

  /** Phase 1841: 本地记录路径（<agentDir>/event-loop/execution-recovery/）。 */
  function recordFilePath(contractId: string): string {
    return path.join(agentDir, 'event-loop', 'execution-recovery', `${contractId}.json`);
  }

  /** 旧 root 共享目录路径（只读基线来源）。 */
  function legacyRecordFilePath(contractId: string): string {
    return path.join(baseDir, 'event-loop', 'execution-recovery', `${contractId}.json`);
  }

  function readInboxMessages(): InboxMessage[] {
    const files = require('fs').readdirSync(inboxPendingDir) as string[];
    return files.map((f: string) =>
      decodeInbox(require('fs').readFileSync(path.join(inboxPendingDir, f), 'utf8')),
    );
  }

  it('停滞 active contract：run() 先 observe 向自身 inbox 写高优 resume event（不调 Runtime reentrant API），owner 证实后 record delivery=confirmed（Phase 1842）', async () => {
    const audit = createMockAudit();
    const loop = makeRecoveryEventLoop(makeIdleRuntime(), audit, {
      probeActivity: async () => ({
        activeContractId: CONTRACT_ID,
        lastActivityAt: Date.now() - 10 * RECOVERY_TIMEOUT_MS,
      }),
    });

    await loop.run();

    const messages = readInboxMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('execution_recovery');
    expect(messages[0].priority).toBe('high');
    expect(messages[0].content).toContain(CONTRACT_ID);
    expect(messages[0].metadata?.contract_id).toBe(CONTRACT_ID);
    // record 已落盘 attempt=1 且 owner 证实消息存在后 delivery=confirmed；
    // inbox 消息以稳定 delivery id 关联（metadata 键，不依赖文件名）
    const persisted = JSON.parse(require('fs').readFileSync(recordFilePath(CONTRACT_ID), 'utf8'));
    expect(persisted.attempts).toBe(1);
    expect(persisted.delivery?.kind).toBe('confirmed');
    expect(messages[0].metadata?.[EXECUTION_RECOVERY_DELIVERY_META_KEY]).toBe(persisted.delivery.id);
    expect(messages[0].id).toBe(persisted.delivery.id);
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME)).toBe(true);
  });

  it('旧 root 共享 attempts=3 record：run() 只读继承到本地，到期继续提醒产出第 4 条 resume（Phase 1840：无契约失败出口；Phase 1841：root 原文不变）', async () => {
    const audit = createMockAudit();
    const lastActivityAt = Date.now() - 10 * RECOVERY_TIMEOUT_MS;
    // 预置旧版 root 共享 attempts=3 的 schema1 record（旧阈值记录升级后作为
    // 归属未知的共享基线继承，在本地继续计数）
    const legacyRaw = JSON.stringify({
      schema_version: 1,
      contractId: CONTRACT_ID,
      observedActivityAt: lastActivityAt,
      attempts: 3,
      lastAttemptAt: Date.now() - 10 * RECOVERY_TIMEOUT_MS,
    });
    require('fs').mkdirSync(path.dirname(legacyRecordFilePath(CONTRACT_ID)), { recursive: true });
    require('fs').writeFileSync(legacyRecordFilePath(CONTRACT_ID), legacyRaw);
    const loop = makeRecoveryEventLoop(makeIdleRuntime(), audit, {
      probeActivity: async () => ({ activeContractId: CONTRACT_ID, lastActivityAt }),
    });

    await loop.run();

    const messages = readInboxMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('execution_recovery');
    expect(messages[0].from).toBe('test-claw');
    expect(messages[0].priority).toBe('high');
    expect(messages[0].metadata?.contract_id).toBe(CONTRACT_ID);
    // 本地 record 变 4 且附旧基线原文/unknown 归属；root 原字节不变；
    // Phase 1842: 旧 root 无实例身份，新义务以全新 delivery id 落盘并确认
    const persisted = JSON.parse(require('fs').readFileSync(recordFilePath(CONTRACT_ID), 'utf8'));
    expect(persisted.attempts).toBe(4);
    expect(persisted.delivery?.kind).toBe('confirmed');
    expect(persisted.delivery?.attempt).toBe(4);
    expect(persisted.legacySharedBaseline).toEqual({ attribution: 'unknown', raw: legacyRaw });
    expect(require('fs').readFileSync(legacyRecordFilePath(CONTRACT_ID), 'utf8')).toBe(legacyRaw);
    expect(audit.entries.some(e =>
      e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_FAILURE_DELIVERED ||
      e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_DELIVERY_FAILED ||
      e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_DELIVERY_REJECTED)).toBe(false);
  });

  it('async task 在途：run() 不判 stall（不写 resume、不建 record）', async () => {
    const audit = createMockAudit();
    const loop = makeRecoveryEventLoop(makeIdleRuntime(), audit, {
      probeActivity: async () => ({
        activeContractId: CONTRACT_ID,
        lastActivityAt: Date.now() - 10 * RECOVERY_TIMEOUT_MS,
      }),
      isAsyncTaskInFlight: async () => true,
    });

    await loop.run();

    expect(readInboxMessages()).toHaveLength(0);
    expect(require('fs').existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
  });

  it('无 executionRecovery 注入：run() 行为不变（local 与 root 均不触碰 record 目录）', async () => {
    const audit = createMockAudit();
    const loop = new EventLoop({
      runtime: makeIdleRuntime(),
      fsFactory,
      agentDir,
      clawId: 'test-claw',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
    });

    await loop.run();

    expect(require('fs').existsSync(path.join(agentDir, 'event-loop'))).toBe(false);
    expect(require('fs').existsSync(path.join(baseDir, 'event-loop'))).toBe(false);
  });

  it('motion 与 worker 同一真实 root：各自 inbox/record 独立接线，重入幂等，无 active 不影响对方', async () => {
    // 固定 Date.now（只 spy Date.now，不冻结等待 timer）+ 固定 lastActivityAt，
    // 避免每次 probe 人为推进活动。
    const FIXED_NOW = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    const lastActivityAt = FIXED_NOW - 10 * RECOVERY_TIMEOUT_MS;

    const motionDir = path.join(baseDir, 'motion');
    const workerDir = path.join(baseDir, 'claws', 'worker-1');
    const motionPending = path.join(motionDir, 'inbox', 'pending');
    const workerPending = path.join(workerDir, 'inbox', 'pending');
    require('fs').mkdirSync(motionPending, { recursive: true });
    require('fs').mkdirSync(workerPending, { recursive: true });

    const makeLoopAt = (
      dir: string,
      clawId: string,
      pendingDir: string,
      audit: AuditLog,
      probeActivity: () => Promise<{ activeContractId?: string; lastActivityAt: number | null }>,
    ): EventLoop => new EventLoop({
      runtime: makeIdleRuntime(),
      fsFactory,
      agentDir: dir,
      clawId,
      audit,
      inbox: { pendingDir, fallbackTimeoutMs: 50 },
      executionRecovery: { probeActivity, timeoutMs: RECOVERY_TIMEOUT_MS },
    });
    const readPending = (pendingDir: string): InboxMessage[] =>
      (require('fs').readdirSync(pendingDir) as string[]).map((f: string) =>
        decodeInbox(require('fs').readFileSync(path.join(pendingDir, f), 'utf8')));
    const localRecordAt = (dir: string): string =>
      path.join(dir, 'event-loop', 'execution-recovery', `${CONTRACT_ID}.json`);

    const motionAudit = createMockAudit();
    const workerAudit = createMockAudit();
    const stalledProbe = async () => ({ activeContractId: CONTRACT_ID, lastActivityAt });

    // 两个 claw 相同 contract ID，各自 run：各自 inbox 一条高优 resume、各自本地 record=1
    await makeLoopAt(motionDir, 'motion', motionPending, motionAudit, stalledProbe).run();
    await makeLoopAt(workerDir, 'worker-1', workerPending, workerAudit, stalledProbe).run();

    const motionMsgs = readPending(motionPending);
    const workerMsgs = readPending(workerPending);
    expect(motionMsgs).toHaveLength(1);
    expect(workerMsgs).toHaveLength(1);
    expect(motionMsgs[0].type).toBe('execution_recovery');
    expect(workerMsgs[0].type).toBe('execution_recovery');
    expect(motionMsgs[0].from).toBe('motion');
    expect(workerMsgs[0].from).toBe('worker-1');
    expect(JSON.parse(require('fs').readFileSync(localRecordAt(motionDir), 'utf8')).attempts).toBe(1);
    expect(JSON.parse(require('fs').readFileSync(localRecordAt(workerDir), 'utf8')).attempts).toBe(1);
    // Phase 1842: 各自 local delivery=confirmed 且 inbox 消息以稳定 delivery id 关联
    const motionRecord = JSON.parse(require('fs').readFileSync(localRecordAt(motionDir), 'utf8'));
    const workerRecord = JSON.parse(require('fs').readFileSync(localRecordAt(workerDir), 'utf8'));
    expect(motionRecord.delivery?.kind).toBe('confirmed');
    expect(workerRecord.delivery?.kind).toBe('confirmed');
    expect(motionMsgs[0].metadata?.[EXECUTION_RECOVERY_DELIVERY_META_KEY]).toBe(motionRecord.delivery.id);
    expect(workerMsgs[0].metadata?.[EXECUTION_RECOVERY_DELIVERY_META_KEY]).toBe(workerRecord.delivery.id);
    expect(motionRecord.delivery.id).not.toBe(workerRecord.delivery.id);
    // 不产生新的 root 共享记录
    expect(require('fs').existsSync(path.join(baseDir, 'event-loop'))).toBe(false);

    // 同窗口重入（重建 loop = 重启）：两者均不重复提醒
    await makeLoopAt(motionDir, 'motion', motionPending, motionAudit, stalledProbe).run();
    await makeLoopAt(workerDir, 'worker-1', workerPending, workerAudit, stalledProbe).run();
    expect(readPending(motionPending)).toHaveLength(1);
    expect(readPending(workerPending)).toHaveLength(1);

    // worker 无 active：不读写；motion 记录原字节不变
    const motionBytes = require('fs').readFileSync(localRecordAt(motionDir), 'utf8');
    const workerBytes = require('fs').readFileSync(localRecordAt(workerDir), 'utf8');
    const idleProbe = async () => ({ activeContractId: undefined, lastActivityAt: FIXED_NOW });
    await makeLoopAt(workerDir, 'worker-1', workerPending, workerAudit, idleProbe).run();
    expect(require('fs').readFileSync(localRecordAt(motionDir), 'utf8')).toBe(motionBytes);
    expect(require('fs').readFileSync(localRecordAt(workerDir), 'utf8')).toBe(workerBytes);
  });

  it('异步 inbox 写失败：本轮正常 drain 仍执行、义务 pending 保留；恢复后下一 run 以同一逻辑 ID 补投并确认（Phase 1842）', async () => {
    const audit = createMockAudit();
    // 共享 agentFs 以便在 Fs 边界注入异步 writeAtomic 错误（不是已退役的
    // writeAtomicSync inbox 点）；record 写（writeAtomicSync/.json）不受影响。
    const sharedAgentFs = new NodeFileSystem({ baseDir: agentDir });
    const factory = (dir: string): FileSystem =>
      dir === agentDir ? sharedAgentFs : new NodeFileSystem({ baseDir: dir });
    const runtime = makeIdleRuntime();
    const fixedActivity = Date.now() - 10 * RECOVERY_TIMEOUT_MS;
    const makeLoop = () => new EventLoop({
      runtime,
      fsFactory: factory,
      agentDir,
      clawId: 'test-claw',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
      executionRecovery: {
        probeActivity: async () => ({ activeContractId: CONTRACT_ID, lastActivityAt: fixedActivity }),
        timeoutMs: RECOVERY_TIMEOUT_MS,
      },
    });

    const realWrite = sharedAgentFs.writeAtomic.bind(sharedAgentFs);
    const writeSpy = vi.spyOn(sharedAgentFs, 'writeAtomic').mockImplementation(async (p, content) => {
      if (String(p).endsWith('.md')) throw Object.assign(new Error('probe inbox async EIO'), { code: 'EIO' });
      return realWrite(p, content);
    });

    await makeLoop().run();

    // 义务 pending 保留、0 消息；投递失败不拖垮本轮——正常 drain 仍执行
    const pendingRecord = JSON.parse(require('fs').readFileSync(recordFilePath(CONTRACT_ID), 'utf8'));
    expect(pendingRecord.attempts).toBe(1);
    expect(pendingRecord.delivery?.kind).toBe('pending');
    expect(readInboxMessages()).toHaveLength(0);
    expect(runtime.prepareInbox).toHaveBeenCalled();
    expect(audit.entries.some(e =>
      e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL &&
      e.some(col => String(col) === 'context=executionRecoveryDelivery') &&
      e.some(col => String(col) === 'stage=write'))).toBe(true);
    const pendingId = pendingRecord.delivery.id;
    writeSpy.mockRestore();

    // 恢复后下一 run（重建 loop = 重启）：同一逻辑 ID 补投并确认
    await makeLoop().run();
    expect(readInboxMessages()).toHaveLength(1);
    const confirmedRecord = JSON.parse(require('fs').readFileSync(recordFilePath(CONTRACT_ID), 'utf8'));
    expect(confirmedRecord.delivery).toMatchObject({ kind: 'confirmed', id: pendingId, attempt: 1 });
    expect(confirmedRecord.attempts).toBe(1);
    expect(readInboxMessages()[0].metadata?.[EXECUTION_RECOVERY_DELIVERY_META_KEY]).toBe(pendingId);
  });

  it('record 读取异常：FATAL 审计后不阻断正常消息 drain', async () => {
    const audit = createMockAudit();
    // 本地 record 损坏（无效 JSON）→ load 严格抛出，EventLoop 外层 catch 记录
    require('fs').mkdirSync(path.dirname(recordFilePath(CONTRACT_ID)), { recursive: true });
    require('fs').writeFileSync(recordFilePath(CONTRACT_ID), 'not-json{{{');
    const runtime = makeIdleRuntime();
    const loop = makeRecoveryEventLoop(runtime, audit, {
      probeActivity: async () => ({
        activeContractId: CONTRACT_ID,
        lastActivityAt: Date.now() - 10 * RECOVERY_TIMEOUT_MS,
      }),
    });

    await loop.run();

    // 恢复观察失败被审计……
    expect(audit.entries.some(e =>
      e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL &&
      e.some(col => String(col) === 'context=executionRecovery'))).toBe(true);
    // ……但正常调度未被阻断：有待处理消息时 drain 仍被调用
    expect(runtime.prepareInbox).toHaveBeenCalled();
    // 损坏 record 原字节不变（不覆盖、不删除）
    expect(require('fs').readFileSync(recordFilePath(CONTRACT_ID), 'utf8')).toBe('not-json{{{');
  });

  it('实际 run：pending 已有同 claw 同契约旧提醒，到期观察不新增提醒/不建 record，正常 drain 仍执行（Phase 1843）', async () => {
    const audit = createMockAudit();
    const runtime = makeIdleRuntime();
    // 真实 owner API 预置旧格式提醒（无 1842 delivery 关联字段）
    const sharedAgentFs = new NodeFileSystem({ baseDir: agentDir });
    const factory = (dir: string): FileSystem =>
      dir === agentDir ? sharedAgentFs : new NodeFileSystem({ baseDir: dir });
    await writeInboxAsync(sharedAgentFs, inboxPendingDir, {
      id: 'old-reminder-1',
      type: 'execution_recovery',
      from: 'test-claw',
      to: '',
      priority: 'high',
      content: 'old reminder body',
      timestamp: new Date(Date.now() - 100 * RECOVERY_TIMEOUT_MS).toISOString(),
      metadata: { contract_id: CONTRACT_ID },
    }, audit);
    const loop = new EventLoop({
      runtime,
      fsFactory: factory,
      agentDir,
      clawId: 'test-claw',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
      executionRecovery: {
        probeActivity: async () => ({
          activeContractId: CONTRACT_ID,
          lastActivityAt: Date.now() - 10 * RECOVERY_TIMEOUT_MS,
        }),
        timeoutMs: RECOVERY_TIMEOUT_MS,
      },
    });

    await loop.run();

    // 没有新提醒、没有新 record；旧消息原样保留；正常 drain 仍被调用
    const messages = readInboxMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('old-reminder-1');
    expect(require('fs').existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    expect(runtime.prepareInbox).toHaveBeenCalled();
    expect(audit.entries.some(e => e[0] === EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME)).toBe(false);
    expect(audit.entries.some(e =>
      e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION &&
      e.some(col => String(col) === 'context=executionRecoveryPendingCheck') &&
      e.some(col => String(col) === 'reason=pending_reminder_exists') &&
      e.some(col => String(col) === 'message_id=old-reminder-1'))).toBe(true);
  });

  it('实际 run：登记前只读 peek 错误，FATAL 审计后不新增义务、正常 drain 仍执行（Phase 1843）', async () => {
    const audit = createMockAudit();
    const runtime = makeIdleRuntime();
    const sharedAgentFs = new NodeFileSystem({ baseDir: agentDir });
    const factory = (dir: string): FileSystem =>
      dir === agentDir ? sharedAgentFs : new NodeFileSystem({ baseDir: dir });
    const realList = sharedAgentFs.list.bind(sharedAgentFs);
    vi.spyOn(sharedAgentFs, 'list').mockImplementation(async (p, opts) => {
      if (String(p).replace(/\\/g, '/').endsWith('inbox/pending')) {
        throw Object.assign(new Error('probe peek EIO'), { code: 'EIO' });
      }
      return realList(p, opts);
    });
    const loop = new EventLoop({
      runtime,
      fsFactory: factory,
      agentDir,
      clawId: 'test-claw',
      audit,
      inbox: { pendingDir: inboxPendingDir, fallbackTimeoutMs: 50 },
      executionRecovery: {
        probeActivity: async () => ({
          activeContractId: CONTRACT_ID,
          lastActivityAt: Date.now() - 10 * RECOVERY_TIMEOUT_MS,
        }),
        timeoutMs: RECOVERY_TIMEOUT_MS,
      },
    });

    await loop.run();

    // 查询未知：不新增提醒/不建 record，FATAL 审计携带原错误；正常 drain 仍执行
    expect(readInboxMessages()).toHaveLength(0);
    expect(require('fs').existsSync(recordFilePath(CONTRACT_ID))).toBe(false);
    expect(runtime.prepareInbox).toHaveBeenCalled();
    expect(audit.entries.some(e =>
      e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL &&
      e.some(col => String(col) === 'context=executionRecoveryPendingCheck') &&
      e.some(col => String(col).includes('probe peek EIO')))).toBe(true);
  });
});
