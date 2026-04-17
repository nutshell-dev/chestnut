/**
 * SubAgent tests — fix 1 (onStepComplete error handling) + fix 8 (timeout cleanup)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubAgent } from '../../src/core/subagent/agent.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import type { Logger } from '../../src/foundation/monitor/types.js';
import type { ILLMService } from '../../src/foundation/llm/index.js';
import type { ToolRegistryImpl } from '../../src/core/tools/registry.js';

// Mock the entire react loop module so runReact is fully controllable
vi.mock('../../src/core/react/loop.js', () => ({
  runReact: vi.fn(),
}));

// Mock ToolExecutor so SubAgent.run() doesn't need real FS / LLM
vi.mock('../../src/core/tools/executor.js', () => ({
  ToolExecutor: vi.fn().mockImplementation(() => ({
    getExecContext: vi.fn().mockReturnValue({
      clawId: 'test-agent',
      clawDir: '/tmp/test',
      profile: 'subagent',
      fs: {},
      stepNumber: 0,
      maxSteps: 20,
      getElapsedMs: () => 0,
      incrementStep: vi.fn(),
    }),
  })),
}));

import { runReact } from '../../src/core/react/loop.js';

function makeSubAgent(
  overrides: { fs?: Partial<FileSystem>; monitor?: Partial<Logger> } = {},
) {
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
    ...overrides.fs,
  } as unknown as FileSystem;

  const mockMonitor: Logger = {
    log: vi.fn(),
    logFileOperation: vi.fn(),
    logError: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    ...overrides.monitor,
  } as unknown as Logger;

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
  } as unknown as ILLMService;

  return {
    agent: new SubAgent({
      agentId: 'test-agent',
      prompt: 'do something',
      clawDir: '/tmp/test',
      llm: mockLLM,
      registry: mockRegistry,
      fs: mockFs,
      monitor: mockMonitor,
      maxSteps: 5,
    }),
    mockFs,
    mockMonitor,
  };
}

describe('SubAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── fix 1: onStepComplete fs.append failure is caught ──────────────────────
  describe('fix 1 — onStepComplete error handling', () => {
    it('when steps log append throws, monitor logs the error and run() still completes', async () => {
      const { agent, mockFs, mockMonitor } = makeSubAgent();

      // fs.append fails for the steps JSONL, succeeds for main log
      (mockFs.append as ReturnType<typeof vi.fn>).mockImplementation(
        (filePath: string) => {
          if (filePath.includes('/steps.jsonl')) {
            return Promise.reject(new Error('append failed'));
          }
          return Promise.resolve();
        },
      );

      // runReact calls onStepComplete once, then returns success
      (runReact as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: { onStepComplete?: () => Promise<void> }) => {
          await opts.onStepComplete?.();
          return { finalText: 'result', stopReason: 'end_turn' };
        },
      );

      const result = await agent.run();

      expect(result).toBe('result');
      expect(mockMonitor.log).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ context: 'SubAgent.onStepComplete' }),
      );
    });

    it('step counters increment even when steps log append throws', async () => {
      // Verify that the catch block does NOT rethrow (run completes normally)
      const { agent, mockFs } = makeSubAgent();

      (mockFs.append as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
        p.includes('/steps.jsonl') ? Promise.reject(new Error('fail')) : Promise.resolve(),
      );

      let stepCallCount = 0;
      (runReact as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: { onStepComplete?: () => Promise<void> }) => {
          await opts.onStepComplete?.();
          stepCallCount++;
          return { finalText: 'ok', stopReason: 'end_turn' };
        },
      );

      await expect(agent.run()).resolves.toBe('ok');
      expect(stepCallCount).toBe(1);
    });
  });

  // ─── fix 8: timeout cleanup after successful run ──────────────────────────
  describe('fix 8 — timeout cleanup', () => {
    it('timeoutController.abort() is called after runReact completes', async () => {
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      (runReact as ReturnType<typeof vi.fn>).mockResolvedValue({
        finalText: 'done',
        stopReason: 'end_turn',
      });

      const { agent } = makeSubAgent();
      await agent.run();

      // abort() should have been called at least once (cleanup path)
      expect(abortSpy).toHaveBeenCalled();
      abortSpy.mockRestore();
    });
  });
});
