/**
 * SubAgent race + ghost callback tests
 * Phase 538 Step B — D.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { SubAgent } from '../../../src/core/subagent/agent.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { SUBAGENT_AUDIT_EVENTS } from '../../../src/core/subagent/audit-events.js';
import type { StreamEvent } from '../../../src/foundation/stream/types.js';

vi.mock('../../../src/core/agent-executor/loop.js', () => ({
  runReact: vi.fn(),
}));

vi.mock('../../../src/foundation/tools/executor.js', () => ({
  ToolExecutor: vi.fn().mockImplementation(() => ({
    getExecContext: vi.fn().mockReturnValue({
      clawId: 'test-agent',
      clawDir: '/tmp/test',
      workspaceDir: path.join('/tmp/test', 'clawspace'),
      profile: 'subagent',
      fs: {},
      stepNumber: 0,
      maxSteps: 20,
      getElapsedMs: () => 0,
      incrementStep: vi.fn(),
    }),
  })),
}));

import { runReact } from '../../../src/core/agent-executor/loop.js';

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

  const agent = new SubAgent({
    agentId: 'test-agent',
    resultDir: 'tasks/queues/results/test-agent',
    messageStore: {
      save: vi.fn().mockResolvedValue(undefined),
    } as any,
    prompt: 'do something',
    clawDir: '/tmp/test',
    workspaceDir: path.join('/tmp/test', 'clawspace'),
    llm: mockLLM,
    registry: mockRegistry,
    fs: mockFs,
    maxSteps: 5,
    timeoutMs: overrides.timeoutMs ?? 1000,
    idleTimeoutMs: overrides.idleTimeoutMs,
    taskStreamWriter: sw,
    auditWriter: mockAuditWriter,
  });

  return { agent, sw, mockAuditWriter };
}

describe('SubAgent race ghost callback (Phase 538)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('timeout 后 runReact callback 不污染 sw（safeSwWrite 丢弃 / ghost audit 写一次）', async () => {
    const { agent, sw, mockAuditWriter } = makeSubAgent({ timeoutMs: 50 });

    // runReact 在 200ms 后才调 callback（timeout 已触发）
    (runReact as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts: {
        onTextDelta?: (delta: string) => void;
        onToolCall?: (name: string, toolUseId: string) => void;
      }) => {
        await new Promise((resolve) => setTimeout(resolve, 500)); // sleep: mock runReact timeout delay
        // timeout 后这些 callback 是 "ghost"
        opts.onTextDelta?.('ghost text');
        opts.onToolCall?.('ghost_tool', 'gt1');
        return { finalText: 'result', stopReason: 'end_turn' };
      },
    );

    await expect(agent.run()).rejects.toThrow();

    // phase 999 r121 P fork C.G.2: 1000ms physical sleep margin → event-driven waitFor
    // (mirror phase 779 + 884 模板 / `feedback_concurrency_race_cluster_sweep §waitFor` Tier 2 active)
    await vi.waitFor(
      () => {
        const interruptedCount = sw.events.filter((e) => e.type === 'turn_interrupted').length;
        const ghostAuditCount = mockAuditWriter.write.mock.calls.filter(
          (call: any[]) => call[0] === SUBAGENT_AUDIT_EVENTS.GHOST_CALLBACK_AFTER_TURN_END,
        ).length;
        expect(interruptedCount).toBe(1);
        expect(ghostAuditCount).toBe(1);
      },
      { timeout: 2000, interval: 50 },
    );

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
    const { agent, sw } = makeSubAgent();

    (runReact as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts: {
        onTextDelta?: (delta: string) => void;
        onToolCall?: (name: string, toolUseId: string) => void;
      }) => {
        opts.onTextDelta?.('hello');
        opts.onToolCall?.('my_tool', 'mt1');
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
