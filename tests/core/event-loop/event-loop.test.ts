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
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { Runtime, TurnResult } from '../../../src/core/runtime/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { LLMContextExceededError } from '../../../src/foundation/llm-orchestrator/index.js';
import { MaxStepsExceededError } from '../../../src/core/agent-executor/errors.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import type { InboxHandle, InboxMessage } from '../../../src/foundation/messaging/types.js';

vi.mock('../../../src/core/event-loop/constants.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/event-loop/constants.js')>('../../../src/core/event-loop/constants.js');
  return {
    ...actual,
    LLM_RETRY_INITIAL_DELAY_MS: 10,
    LLM_RETRY_MAX_DELAY_MS: 50,
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

  it('MaxStepsExceededError 走 markLoopCrashed + ackHandles 破热循环', async () => {
    const audit = createMockAudit();
    const crashErr = new MaxStepsExceededError(10);

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: crashErr }));
    const markLoopCrashed = vi.fn().mockResolvedValue(undefined);
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
      retryLastTurn: vi.fn().mockResolvedValue(makeTurnResult('success')),
      markLoopCrashed,
      abort: vi.fn(),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(markLoopCrashed).toHaveBeenCalledWith(
      crashErr,
      expect.arrayContaining([expect.objectContaining({ metadata: { contract_id: 'test-contract' } })]),
    );
    expect(ackHandles).toHaveBeenCalledWith(['handle-1'], 'agent_loop_crash');
    expect(nackHandles).not.toHaveBeenCalled();
    const fatalEntries = audit.entries.filter(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.FATAL && e.some(c => String(c).includes('agent_loop_crash')),
    );
    expect(fatalEntries.length).toBeGreaterThan(0);
  });

  it('crash error 无 contract_id 时 markLoopCrashed 退化、仍 ackHandles', async () => {
    const audit = createMockAudit();
    const crashErr = new MaxStepsExceededError(10);

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: crashErr }));
    const markLoopCrashed = vi.fn().mockResolvedValue(undefined);
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
      retryLastTurn: vi.fn().mockResolvedValue(makeTurnResult('success')),
      markLoopCrashed,
      abort: vi.fn(),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    expect(markLoopCrashed).toHaveBeenCalledWith(crashErr, []);
    expect(ackHandles).toHaveBeenCalledWith(['handle-1'], 'agent_loop_crash');
    expect(nackHandles).not.toHaveBeenCalled();
  });

  it('context_exceeded 错误走 llmRetry + reactive trim，耗尽后 cooldown', async () => {
    vi.useFakeTimers();
    const audit = createMockAudit();
    const ctxErr = new LLMContextExceededError('test-provider', 400, 'context length exceeded');

    const processTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: ctxErr }));
    const retryLastTurn = vi.fn().mockResolvedValue(makeTurnResult('failed', { error: ctxErr }));
    const reactiveTrim = vi.fn().mockResolvedValue(undefined);

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
      processTurn,
      ackHandles: vi.fn().mockResolvedValue(undefined),
      nackHandles: vi.fn().mockResolvedValue(undefined),
      reactiveTrim,
      retryLastTurn,
      abort: vi.fn(),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);

    // 第 1 轮：processTurn 失败 → 进入 retry pending
    const run1 = eventLoop.run();
    await vi.advanceTimersByTimeAsync(20);
    await run1;

    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(reactiveTrim).toHaveBeenCalledTimes(1);

    // 后续 3 轮 retry（LLM_MAX_RETRIES=3），每次前进足够覆盖指数退避
    for (let i = 0; i < 3; i++) {
      const run = eventLoop.run();
      await vi.advanceTimersByTimeAsync(100);
      await run;
    }

    expect(retryLastTurn).toHaveBeenCalledTimes(3);
    expect(reactiveTrim).toHaveBeenCalledTimes(3);

    const retryEntries = audit.entries.filter(e => e[0] === EVENTLOOP_AUDIT_EVENTS.LLM_RETRY);
    expect(retryEntries.length).toBe(3);

    const cooldownEntries = audit.entries.filter(
      e => e[0] === EVENTLOOP_AUDIT_EVENTS.COOLDOWN &&
        e.some(c => String(c).includes('context_exceeded_exhausted')),
    );
    expect(cooldownEntries.length).toBeGreaterThan(0);
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
      retryLastTurn: vi.fn().mockResolvedValue(makeTurnResult('success')),
      abort: vi.fn(),
    } as unknown as Runtime;

    const eventLoop = makeEventLoop(runtime, audit);
    await eventLoop.run();

    const chainEntry = audit.entries.find(e => e[0] === EVENTLOOP_AUDIT_EVENTS.ITERATION && e.some(c => String(c).includes(LOOP_ITERATION_TYPES.chain)));
    expect(chainEntry).toBeDefined();
    expect(String(chainEntry!.join('\t'))).toContain('injected=2');
    expect(String(chainEntry!.join('\t'))).toContain('chain_total=3');
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
      retryLastTurn: vi.fn().mockResolvedValue(makeTurnResult('success')),
      abort: vi.fn(),
      getCurrentTraceId: vi.fn().mockReturnValue(undefined),
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
});
