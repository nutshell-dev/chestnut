/**
 * phase 1029: subagent ToolExecutor inherits globalConfig.tool_timeout_ms (α-inherit-config / F-2)
 * Reverse tests verify the cascade: RunSubagentOptions → ToolExecutor.defaultTimeoutMs
 *
 * phase 1489 update：ToolExecutor 注入 SubAgentOptions、SubAgent 不再 own toolTimeoutMs / ctor / 装配。
 * cascade source-of-truth 从 `new SubAgent → new ToolExecutor` 迁到 `runSubagent → new ToolExecutor`。
 * 测试随之 reframe 全走 runSubagent / mirror 原 test 3「runSubagent caller passes through」唯一路径。
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
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawDir: '/tmp/test',
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      workspaceDir: path.join('/tmp/test', 'clawspace'),
      profile: 'subagent',
      fs: {},
      stepNumber: 0,
      maxSteps: 20,
      getElapsedMs: () => 0,
      incrementStep: vi.fn(),
      stopRequested: false,
      requestStop: vi.fn(),
      readFileState: new Map(),
    }),
  })),
}));

vi.mock('../../../src/foundation/audit/index.js', () => ({
  createAuditWriter: vi.fn().mockReturnValue({ write: vi.fn() }),
}));

vi.mock('../../../src/foundation/dialog-store/index.js', () => ({
  createDialogStore: vi.fn().mockReturnValue({ save: vi.fn().mockResolvedValue(undefined) }),
}));

import { runSubagent } from '../../../src/core/subagent/run.js';
import { ToolExecutor } from '../../../src/foundation/tools/executor.js';

function makeRunSubagentOpts(overrides: { toolTimeoutMs?: number } = {}) {
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

  return {
    agentId: 'test-agent',
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawDir: '/tmp/test',
    fs: mockFs as any,
    llm: {} as any,
    registry: mockRegistry as any,
    prompt: 'test',
    systemPrompt: 'system',
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    resultDir: '/tmp/test/result',
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    syncDir: '/tmp/test/tasks/sync',
    maxSteps: 5,
    ...overrides,
  };
}

describe('phase 1029 / phase 1489 reframe: runSubagent → ToolExecutor.defaultTimeoutMs cascade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runSubagent toolTimeoutMs passes through to ToolExecutor.defaultTimeoutMs (反向 1)', async () => {
    const customTimeout = 90_000;
    await runSubagent(makeRunSubagentOpts({ toolTimeoutMs: customTimeout }));

    expect(ToolExecutor).toHaveBeenCalledTimes(1);
    const ctorCall = (ToolExecutor as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ctorCall[0].defaultTimeoutMs).toBe(customTimeout);
  });

  it('0 toolTimeoutMs → ToolExecutor.defaultTimeoutMs undefined / fallback L2 const (反向 2 backward compat)', async () => {
    await runSubagent(makeRunSubagentOpts());

    expect(ToolExecutor).toHaveBeenCalledTimes(1);
    const ctorCall = (ToolExecutor as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ctorCall[0].defaultTimeoutMs).toBeUndefined();
  });

  it('caller explicit toolTimeoutMs cascade (反向 3 / phase 1029 original test 3)', async () => {
    await runSubagent(makeRunSubagentOpts({ toolTimeoutMs: 123_000 }));

    expect(ToolExecutor).toHaveBeenCalledTimes(1);
    const ctorCall = (ToolExecutor as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ctorCall[0].defaultTimeoutMs).toBe(123_000);
  });
});
