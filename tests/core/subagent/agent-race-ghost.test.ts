/**
 * SubAgent race + ghost callback tests
 * Phase 538 Step B — D.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { SubAgent } from '../../../src/core/subagent/agent.js';
import type { ToolExecutor } from '../../../src/foundation/tools/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';
import type { StreamEvent } from '../../../src/foundation/stream/types.js';
import { createSubAgentLifecycleSink } from '../../../src/core/subagent/lifecycle-sink.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

const RACE_TURN_TIMEOUT_MS = 50; // 真实 turn 超时预算，驱动 abort / ghost / settle 竞争路径。

/**
 * Promise barrier release for mock runReact ghost-callback delay.
 * Released after agent.run() rejects with timeout, removing wall-clock dependency.
 */
let runReactRelease: (() => void) | undefined;

// phase 1489: ToolExecutor 注入 SubAgentOptions / 不再 vi.mock executor.js
// phase 1858 Step E: overrides 透传（测试需在 mock runReact 内观测 abort signal）
function makeMockToolExecutor(): ToolExecutor {
  return {
    getExecContext: vi.fn((_profile: string, overrides?: Record<string, unknown>) => ({
      clawId: 'test-agent',
      clawDir: '/tmp/test',
      workspaceDir: path.join('/tmp/test', 'clawspace'),
      profile: 'subagent',
      fs: {},
      stepNumber: 0,
      maxSteps: 20,
      getElapsedMs: () => 0,
      incrementStep: vi.fn(),
      ...(overrides ?? {}),
    })),
  } as unknown as ToolExecutor;
}

class CollectingStreamWriter {
  events: StreamEvent[] = [];
  write(event: StreamEvent): void {
    this.events.push(event);
  }
}

function makeSubAgent(overrides: { timeoutMs?: number; idleTimeoutMs?: number } = {}) {
  const mockFs: FileSystem = {
    read: vi.fn().mockResolvedValue(''),
    write: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn(),
    move: vi.fn().mockResolvedValue(undefined),
    copy: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 0, mtime: new Date() }),
  } as unknown as FileSystem;

  const mockAuditWriter = { write: vi.fn() };

  const mockRegistry = {
    getAll: vi.fn().mockReturnValue([]),
    formatForLLM: vi.fn().mockReturnValue([]),
  } as unknown as ToolRegistryImpl;

  const mockLLM = {
    call: vi.fn(),
    stream: vi.fn(),
    close: vi.fn(),
    healthCheck: vi.fn(),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  } as unknown as LLMOrchestrator;

  const sw = new CollectingStreamWriter();
  const runReact = vi.fn();

  const agent = new SubAgent({
    agentId: 'test-agent',
    resultDir: 'tasks/queues/results/test-agent',
    messageStore: {
      save: vi.fn().mockResolvedValue(undefined),
    } as any,
    prompt: 'do something',
    toolExecutor: makeMockToolExecutor(),
    llm: mockLLM,
    registry: mockRegistry,
    fs: mockFs,
    maxSteps: 5,
    timeoutMs: overrides.timeoutMs ?? SUBAGENT_SHORT_TIMEOUT_MS,
    idleTimeoutMs: overrides.idleTimeoutMs,
    taskStreamWriter: sw,
    sink: createSubAgentLifecycleSink({ auditWriter: mockAuditWriter as any, agentId: 'test-agent', traceId: 'trace-test' }),
    runReact,
  });

  return { agent, sw, mockAuditWriter, runReact };
}

describe('SubAgent race ghost callback (Phase 538)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('timeout 只发 signal：真实收敛前不关闭流，晚到 callback 完整落盘后再结算', async () => {
    const { agent, sw, mockAuditWriter, runReact } = makeSubAgent({ timeoutMs: RACE_TURN_TIMEOUT_MS });
    let abortObservedResolve!: () => void;
    const abortObserved = new Promise<void>(resolve => { abortObservedResolve = resolve; });

    runReact.mockImplementation(async (opts: {
      ctx: { signal: AbortSignal };
      stepCallbacks?: {
        onTextDelta?: (delta: string) => void;
        onToolCall?: (name: string, toolUseId: string) => Promise<void>;
      };
    }) => {
      if (opts.ctx.signal.aborted) abortObservedResolve();
      else opts.ctx.signal.addEventListener('abort', () => { abortObservedResolve(); }, { once: true });
      await new Promise<void>(resolve => { runReactRelease = resolve; });
      opts.stepCallbacks?.onTextDelta?.('late text');
      await opts.stepCallbacks?.onToolCall?.('late_tool', 'lt1');
      return { finalText: 'late result', stopReason: 'end_turn' };
    });

    let settled = false;
    const running = agent.run();
    void running.catch(() => { settled = true; });
    await abortObserved;
    expect(settled).toBe(false);
    expect(sw.events.filter(event => event.type === 'turn_interrupted')).toHaveLength(0);

    runReactRelease!();
    const err = await running.catch(error => error);
    expect(err).toMatchObject({ subagentLateResult: { text: 'late result', stopReason: 'end_turn' } });
    expect(sw.events.filter(event => event.type === 'text_delta' && event.delta === 'late text')).toHaveLength(1);
    expect(sw.events.filter(event => event.type === 'tool_call' && event.name === 'late_tool')).toHaveLength(1);
    expect(sw.events.filter(event => event.type === 'turn_interrupted')).toHaveLength(1);
    expect(mockAuditWriter.write.mock.calls.filter(
      call => call[0] === SUBAGENT_AUDIT_EVENTS.GHOST_CALLBACK_AFTER_TURN_END,
    )).toHaveLength(0);
  });

  it('正常完成时 sw 不受 safeSwWrite 影响', async () => {
    const { agent, sw, runReact } = makeSubAgent();

    runReact.mockImplementation(
      async (opts: {
        onTextDelta?: (delta: string) => void;
        onToolCall?: (name: string, toolUseId: string) => void;
      }) => {
        opts.stepCallbacks?.onTextDelta?.('hello');
        opts.stepCallbacks?.onToolCall?.('my_tool', 'mt1');
        return { finalText: 'done', stopReason: 'end_turn' };
      },
    );

    await agent.run();

    // 正常 callback 应写入
    const textDeltas = sw.events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBe(1);
    expect(textDeltas[0].delta).toBe('hello');

    const toolCalls = sw.events.filter((e) => e.type === 'tool_call');
    expect(toolCalls.length).toBe(1);

    const turnEnds = sw.events.filter((e) => e.type === 'turn_end');
    expect(turnEnds.length).toBe(1);
  });
});

describe('Phase 2248 Step D: timeout 与真实 convergence 分离', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('合作执行在 abort 后收敛，保留 timeout 原因且不产生 still-running 伪证据', async () => {
    const { agent, mockAuditWriter, runReact } = makeSubAgent({ timeoutMs: RACE_TURN_TIMEOUT_MS });
    runReact.mockImplementation(async (opts: { ctx: { signal: AbortSignal } }) => {
      await new Promise<never>((_, reject) => {
        if (opts.ctx.signal.aborted) {
          reject(new Error('aborted cooperatively'));
          return;
        }
        opts.ctx.signal.addEventListener('abort', () => reject(new Error('aborted cooperatively')), { once: true });
      });
    });

    const err = await agent.run().catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toHaveProperty('subagentStillRunning');
    expect(mockAuditWriter.write.mock.calls.filter(
      call => call[0] === SUBAGENT_AUDIT_EVENTS.RUNREACT_ABORT_STILL_RUNNING,
    )).toHaveLength(0);
  });

  it('非合作执行收到 abort 后仍不提前 reject；release 后才保存并交付原 timeout', async () => {
    const { agent, mockAuditWriter, runReact } = makeSubAgent({ timeoutMs: RACE_TURN_TIMEOUT_MS });
    let release!: () => void;
    let abortObservedResolve!: () => void;
    const abortObserved = new Promise<void>(resolve => { abortObservedResolve = resolve; });
    runReact.mockImplementation(async (opts: { ctx: { signal: AbortSignal } }) => {
      opts.ctx.signal.addEventListener('abort', () => { abortObservedResolve(); }, { once: true });
      await new Promise<void>(resolve => { release = resolve; });
      return { finalText: 'late', stopReason: 'end_turn' };
    });

    let settled = false;
    const running = agent.run();
    void running.catch(() => { settled = true; });
    await abortObserved;
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(settled).toBe(false);
    expect(mockAuditWriter.write.mock.calls.filter(
      call => call[0] === SUBAGENT_AUDIT_EVENTS.RUNREACT_ABORT_STILL_RUNNING,
    )).toHaveLength(0);

    release();
    const err = await running.catch(error => error);
    expect(err).toMatchObject({
      name: 'ToolTimeoutError',
      subagentLateResult: { text: 'late', stopReason: 'end_turn' },
    });
    expect(err).not.toHaveProperty('subagentStillRunning');
  });
});
