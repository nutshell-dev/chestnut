/**
 * phase 1029: subagent ToolExecutor inherits globalConfig.tool_timeout_ms (α-inherit-config / F-2)
 * Reverse tests verify the cascade: RunSubagentOptions → SubAgentOptions → ToolExecutor.defaultTimeoutMs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('../../../src/core/agent-executor/loop.js', () => ({
  runReact: vi.fn().mockResolvedValue({ finalText: 'done', stopReason: 'end_turn' }),
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
      stopRequested: false,
      requestStop: vi.fn(),
      fullyReadPaths: new Set(),
    }),
  })),
}));

vi.mock('../../../src/foundation/audit/index.js', () => ({
  createAuditWriter: vi.fn().mockReturnValue({ write: vi.fn() }),
}));

vi.mock('../../../src/foundation/dialog-store/index.js', () => ({
  createDialogStore: vi.fn().mockReturnValue({ save: vi.fn().mockResolvedValue(undefined) }),
}));

import { SubAgent } from '../../../src/core/subagent/agent.js';
import { runSubagent } from '../../../src/core/subagent/run.js';
import { ToolExecutor } from '../../../src/foundation/tools/executor.js';

function makeMinimalSubAgentOpts(overrides: { toolTimeoutMs?: number } = {}) {
  const mockFs = {
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
  } as unknown as import('../../../src/foundation/fs/types.js').FileSystem;

  return {
    agentId: 'test-agent',
    resultDir: 'tasks/queues/results/test-agent',
    messageStore: { save: vi.fn().mockResolvedValue(undefined) } as any,
    prompt: 'do something',
    clawDir: '/tmp/test',
    workspaceDir: path.join('/tmp/test', 'clawspace'),
    llm: {
      call: vi.fn(),
      stream: vi.fn(),
      close: vi.fn(),
      healthCheck: vi.fn(),
      getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
    } as unknown as import('../../../src/foundation/llm-orchestrator/index.js').LLMOrchestrator,
    registry: {
      getAll: vi.fn().mockReturnValue([]),
      formatForLLM: vi.fn().mockReturnValue([]),
    } as unknown as import('../../../src/foundation/tools/index.js').ToolRegistry,
    fs: mockFs,
    maxSteps: 5,
    taskStreamWriter: { write: vi.fn() } as any,
    auditWriter: { write: vi.fn() } as any,
    ...overrides,
  };
}

describe('phase 1029: subagent inherits tool timeout from caller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('SubAgent.toolTimeoutMs passed to ToolExecutor.defaultTimeoutMs (反向 1)', async () => {
    const customTimeout = 90_000;
    const agent = new SubAgent(makeMinimalSubAgentOpts({ toolTimeoutMs: customTimeout }));
    await agent.run();

    expect(ToolExecutor).toHaveBeenCalledTimes(1);
    const ctorCall = (ToolExecutor as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ctorCall[0].defaultTimeoutMs).toBe(customTimeout);
  });

  it('0 toolTimeoutMs passes → ToolExecutor fallback L2 const 60s (反向 2 backward compat)', async () => {
    const agent = new SubAgent(makeMinimalSubAgentOpts());
    await agent.run();

    expect(ToolExecutor).toHaveBeenCalledTimes(1);
    const ctorCall = (ToolExecutor as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ctorCall[0].defaultTimeoutMs).toBeUndefined();
  });

  it('runSubagent caller passes toolTimeoutMs through to SubAgent → ToolExecutor (反向 3 cascade)', async () => {
    const mockRegistry = {
      getAll: vi.fn().mockReturnValue([]),
      formatForLLM: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue({ capturedResult: undefined }),
    };

    const mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      append: vi.fn().mockResolvedValue(undefined),
      appendSync: vi.fn(),
    };

    await runSubagent({
      agentId: 'test-agent',
      callerClawId: 'claw-test',
      clawDir: '/tmp/test',
      fs: mockFs as any,
      llm: {} as any,
      registry: mockRegistry as any,
      prompt: 'test',
      systemPrompt: 'system',
      resultDir: '/tmp/test/result',
      maxSteps: 5,
      toolTimeoutMs: 123_000,
    });

    expect(ToolExecutor).toHaveBeenCalledTimes(1);
    const ctorCall = (ToolExecutor as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ctorCall[0].defaultTimeoutMs).toBe(123_000);
  });
});
