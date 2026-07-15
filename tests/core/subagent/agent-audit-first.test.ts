/**
 * Phase 1122: subagent onToolResult audit-first emit ordering
 *
 * 验证 agent.ts onToolResult callback 内 auditWriter.write 先于 safeSwWrite
 * (与 runtime.ts:507-512 audit-first canonical 对齐)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { SubAgent } from '../../../src/core/subagent/agent.js';
import type { ToolExecutor } from '../../../src/foundation/tools/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { AGENT_STREAM_EVENTS } from '../../../src/core/agent-executor/index.js';
import type { StreamEvent } from '../../../src/foundation/stream/types.js';

/**
 * Promise barrier release for mock runReact ghost-callback delay.
 * Released after agent.run() rejects with timeout, removing wall-clock dependency.
 */
let runReactRelease: (() => void) | undefined;

// phase 1489: ToolExecutor 注入 SubAgentOptions / 不再 vi.mock executor.js
function makeMockToolExecutor(): ToolExecutor {
  return {
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
  } as unknown as ToolExecutor;
}

class CollectingStreamWriter {
  events: StreamEvent[] = [];
  write(event: StreamEvent): void {
    this.events.push(event);
  }
}

function makeSubAgent(overrides: { timeoutMs?: number } = {}) {
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

  const mockAuditWriter = {
    write: vi.fn(),
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };

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
    taskStreamWriter: sw,
    auditWriter: mockAuditWriter,
    runReact,
  });

  return { agent, sw, mockAuditWriter, runReact };
}

describe('subagent onToolResult emit ordering (phase 1122 audit-first)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('audit emit 先于 stream emit (canonical ordering)', async () => {
    const { agent, sw, mockAuditWriter, runReact } = makeSubAgent();
    const swWriteSpy = vi.spyOn(sw, 'write');

    runReact.mockImplementation(
      async (opts: {
        onToolResult?: (name: string, toolUseId: string, result: any, step: number, maxSteps: number) => void;
      }) => {
        opts.onToolResult?.('test_tool', 'tu1', { success: true, content: 'ok result' }, 0, 5);
        return { finalText: 'done', stopReason: 'end_turn' };
      },
    );

    await agent.run();

    // 定位 audit 和 stream 的调用索引
    const auditIdx = mockAuditWriter.write.mock.calls.findIndex(
      (call: any[]) => call[0] === 'tool_result',
    );
    const streamIdx = swWriteSpy.mock.calls.findIndex(
      (call: any[]) => (call[0] as StreamEvent).type === AGENT_STREAM_EVENTS.TOOL_RESULT,
    );

    expect(auditIdx).toBeGreaterThanOrEqual(0);
    expect(streamIdx).toBeGreaterThanOrEqual(0);

    const auditCallOrder = mockAuditWriter.write.mock.invocationCallOrder[auditIdx];
    const streamCallOrder = swWriteSpy.mock.invocationCallOrder[streamIdx];

    expect(auditCallOrder).toBeLessThan(streamCallOrder);
  });

  it('反向 1 (误删反向)：test infra 可检测 audit emit 缺失', async () => {
    const { agent, sw, mockAuditWriter, runReact } = makeSubAgent();
    const swWriteSpy = vi.spyOn(sw, 'write');
    const originalWrite = mockAuditWriter.write;

    // 模拟 audit 对 tool_result 被误删：纯函数拦截 tool_result，其他事件透传回原始 mock
    let interceptedToolResult = 0;
    mockAuditWriter.write = (event: string, ...args: any[]) => {
      if (event === 'tool_result') {
        interceptedToolResult++;
        return;
      }
      return originalWrite(event, ...args);
    };

    runReact.mockImplementation(
      async (opts: {
        onToolResult?: (name: string, toolUseId: string, result: any, step: number, maxSteps: number) => void;
      }) => {
        opts.onToolResult?.('test_tool', 'tu1', { success: true, content: 'ok result' }, 0, 5);
        return { finalText: 'done', stopReason: 'end_turn' };
      },
    );

    await agent.run();

    // 拦截到 1 次 tool_result（说明 infra 能观测到 audit emit）
    expect(interceptedToolResult).toBe(1);

    // 原始 mock 中无 tool_result 记录（验证误删后 audit 缺失可被检测）
    const toolResultCalls = originalWrite.mock.calls.filter(
      (call: any[]) => call[0] === 'tool_result',
    );
    expect(toolResultCalls.length).toBe(0);

    // stream 仍正常写入
    const toolResultStreamEvents = swWriteSpy.mock.calls.filter(
      (call: any[]) => (call[0] as StreamEvent).type === AGENT_STREAM_EVENTS.TOOL_RESULT,
    );
    expect(toolResultStreamEvents.length).toBe(1);
  });

  it('反向 2 (schema 反向)：audit payload key sequence 不变', async () => {
    const { agent, sw, mockAuditWriter, runReact } = makeSubAgent();
    vi.spyOn(sw, 'write');

    runReact.mockImplementation(
      async (opts: {
        onToolResult?: (name: string, toolUseId: string, result: any, step: number, maxSteps: number) => void;
      }) => {
        opts.onToolResult?.('my_tool', 'mid42', { success: false, content: 'error detail' }, 2, 10);
        return { finalText: 'done', stopReason: 'end_turn' };
      },
    );

    await agent.run();

    const auditCall = mockAuditWriter.write.mock.calls.find(
      (call: any[]) => call[0] === 'tool_result',
    );

    expect(auditCall).toBeDefined();
    // phase 140: named cols for tool_result (tool_use_id, step, contract_id, trace_id, status, summary, content_size)
    expect(auditCall![0]).toBe('tool_result');
    expect(auditCall![1]).toBe('my_tool');
    const auditCols = auditCall!.slice(2) as string[];
    expect(auditCols.some((c: string) => c === 'tool_use_id=mid42')).toBe(true);
    expect(auditCols.some((c: string) => c === 'step=2')).toBe(true);
    expect(auditCols.some((c: string) => c === 'status=err')).toBe(true);
    expect(auditCols.some((c: string) => c === 'summary=error detail')).toBe(true);
    expect(auditCols.some((c: string) => c.startsWith('content_size='))).toBe(true);
  });

  it('反向 3 (边界路径反向)：swClosed 状态下 audit 仍 emit', async () => {
    const { agent, sw, mockAuditWriter, runReact } = makeSubAgent({ timeoutMs: 50 });
    const swWriteSpy = vi.spyOn(sw, 'write');

    // phase 373: wrap mockAuditWriter.write 在 'tool_result' 时 resolve、替原 vi.waitFor polling
    let toolResultAuditedResolve!: () => void;
    const toolResultAudited = new Promise<void>((r) => { toolResultAuditedResolve = r; });
    const originalWrite = mockAuditWriter.write;
    mockAuditWriter.write = vi.fn((event: string, ...args: unknown[]) => {
      originalWrite(event, ...(args as []));
      if (event === 'tool_result') toolResultAuditedResolve();
    });

    // timeout 后 runReact 才调 onToolResult → ghost callback
    runReact.mockImplementation(
      async (opts: {
        onToolResult?: (name: string, toolUseId: string, result: any, step: number, maxSteps: number) => void;
      }) => {
        await new Promise<void>(resolve => { runReactRelease = resolve; }); // barrier: mock runReact ghost-callback delay
        opts.onToolResult?.('ghost_tool', 'gt1', { success: true, content: 'ghost' }, 0, 5);
        return { finalText: 'done', stopReason: 'end_turn' };
      },
    );

    await expect(agent.run()).rejects.toThrow();
    runReactRelease!();
    await toolResultAudited;

    // audit 对 tool_result 仍写一次
    const toolResultAudits = mockAuditWriter.write.mock.calls.filter(
      (call: any[]) => call[0] === 'tool_result',
    );
    expect(toolResultAudits.length).toBe(1);
    expect(toolResultAudits[0][1]).toBe('ghost_tool');

    // stream 被 safeSwWrite gate 掉（silent skip）
    const toolResultStreamEvents = swWriteSpy.mock.calls.filter(
      (call: any[]) => (call[0] as StreamEvent).type === AGENT_STREAM_EVENTS.TOOL_RESULT,
    );
    expect(toolResultStreamEvents.length).toBe(0);
  });
});
