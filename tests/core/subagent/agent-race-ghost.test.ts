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
// phase 1858 Step E (SA-D4): typed 仍运行证据经 barrel 消费
import { getSubagentStillRunning } from '../../../src/core/subagent/index.js';
import type { StreamEvent } from '../../../src/foundation/stream/types.js';
import { createSubAgentLifecycleSink } from '../../../src/core/subagent/lifecycle-sink.js';

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
    timeoutMs: overrides.timeoutMs ?? 1000,
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

  it('timeout 后 runReact callback 不污染 sw（safeSwWrite 丢弃 / ghost audit 写一次）', async () => {
    const { agent, sw, mockAuditWriter, runReact } = makeSubAgent({ timeoutMs: 50 });

    // phase 373: wrap mockAuditWriter.write 在 GHOST_CALLBACK_AFTER_TURN_END 时 resolve、替原 vi.waitFor polling
    let ghostAuditResolve!: () => void;
    const ghostAudited = new Promise<void>((r) => { ghostAuditResolve = r; });
    const originalWrite = mockAuditWriter.write;
    mockAuditWriter.write = vi.fn((event: string, ...args: unknown[]) => {
      originalWrite(event, ...(args as []));
      if (event === SUBAGENT_AUDIT_EVENTS.GHOST_CALLBACK_AFTER_TURN_END) ghostAuditResolve();
    });

    // runReact 在 timeout 后才调 callback（timeout 已触发）
    runReact.mockImplementation(
      async (opts: {
        onTextDelta?: (delta: string) => void;
        onToolCall?: (name: string, toolUseId: string) => void;
      }) => {
        await new Promise<void>(resolve => { runReactRelease = resolve; }); // barrier: mock runReact ghost-callback delay
        // timeout 后这些 callback 是 "ghost"
        opts.stepCallbacks?.onTextDelta?.('ghost text');
        opts.stepCallbacks?.onToolCall?.('ghost_tool', 'gt1');
        return { finalText: 'result', stopReason: 'end_turn' };
      },
    );

    await expect(agent.run()).rejects.toThrow();
    runReactRelease!();
    await ghostAudited;
    // turn_interrupted 应在 ghost callback 前已 emit（agent run reject 时）
    const interruptedCount = sw.events.filter((e) => e.type === 'turn_interrupted').length;
    expect(interruptedCount).toBe(1);

    // turn_interrupted 已写入
    const interrupted = sw.events.filter((e) => e.type === 'turn_interrupted');
    expect(interrupted.length).toBe(1);

    // ghost callback 被丢弃，不写入 stream
    const ghostEvents = sw.events.filter(
      (e) => e.type === 'text_delta' || e.type === 'tool_call',
    );
    expect(ghostEvents.length).toBe(0);

    // ghost audit 只写一次
    const ghostAudits = mockAuditWriter.write.mock.calls.filter(
      (call: any[]) => call[0] === SUBAGENT_AUDIT_EVENTS.GHOST_CALLBACK_AFTER_TURN_END,
    );
    expect(ghostAudits.length).toBe(1);
    expect(ghostAudits[0][1]).toContain('agentId=');
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

describe('phase 1858 Step E (SA-D4): terminal outcome 前可靠 join / typed 仍运行证据', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('① 合作执行：race 失败后 settle 窗口内收敛 → subagentStillRunning=false、无留证行', async () => {
    const { agent, mockAuditWriter, runReact } = makeSubAgent({ timeoutMs: 50 });

    // 合作 mock：signal abort（turn_timeout）后立即收敛
    runReact.mockImplementation(async (opts: { ctx: { signal: AbortSignal } }) => {
      await new Promise<never>((_, reject) => {
        if (opts.ctx.signal.aborted) {
          reject(new Error('aborted cooperatively'));
          return;
        }
        opts.ctx.signal.addEventListener('abort', () => reject(new Error('aborted cooperatively')), { once: true });
      });
    });

    const err = await agent.run().catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(getSubagentStillRunning(err)).toBe(false);
    expect((err as { subagentStillRunning?: boolean }).subagentStillRunning).toBe(false);

    const rows = mockAuditWriter.write.mock.calls.filter(
      (call: unknown[]) => call[0] === SUBAGENT_AUDIT_EVENTS.RUNREACT_ABORT_STILL_RUNNING,
    );
    expect(rows).toHaveLength(0);
  });

  it('② 非合作执行：超窗仍未收敛 → typed stillRunning=true + audit 留证（settle_ms 与常量一致）', async () => {
    const { agent, mockAuditWriter, runReact } = makeSubAgent({ timeoutMs: 50 });

    let release!: () => void;
    runReact.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { finalText: 'late', stopReason: 'end_turn' };
    });

    const err = await agent.run().catch((e) => e);

    expect(getSubagentStillRunning(err)).toBe(true);
    expect((err as { subagentStillRunning?: boolean }).subagentStillRunning).toBe(true);

    const rows = mockAuditWriter.write.mock.calls.filter(
      (call: unknown[]) => call[0] === SUBAGENT_AUDIT_EVENTS.RUNREACT_ABORT_STILL_RUNNING,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('agentId=test-agent');
    expect(rows[0]).toContain('settle_ms=100');

    release();
  });
});
