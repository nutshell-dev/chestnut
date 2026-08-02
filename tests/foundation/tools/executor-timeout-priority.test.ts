import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { ToolExecutorImpl } from '../../../src/foundation/tools/executor.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { TOOL_EXEC_CLEANUP_BUDGET_MS } from '../../../src/foundation/tools/constants.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { Tool } from '../../../src/foundation/tool-protocol/index.js';

// phase 1269 Step D: these fixtures use a never-settling tool, so after the
// timeout winner the executor waits the full cleanup barrier before
// returning. Expected wall time is therefore timeoutMs + cleanup budget.
const TIMEOUT_RETURN_MS = (timeoutMs: number) => timeoutMs + TOOL_EXEC_CLEANUP_BUDGET_MS;

describe('ToolExecutor — timeoutMs priority (options > tool.defaultTimeoutMs > executor.defaultTimeoutMs)', () => {
  let registry: ToolRegistryImpl;
  let mockFs: FileSystem;

  beforeEach(() => {
    registry = new ToolRegistryImpl();
    mockFs = {} as FileSystem;
  });

  const makeSlowTool = (defaultTimeoutMs?: number): Tool => ({
    name: 'slow',
    description: 'Never resolves',
    schema: { type: 'object' },
    readonly: true,
    idempotent: true,
    defaultTimeoutMs,
    execute: async () => {
      await new Promise(() => {}); // never resolves
      return { success: true, content: '' };
    },
  });

  const makeCtx = () =>
    new ExecContextImpl({
      clawId: 'test',
      clawDir: '/test',
      profile: 'full',
      fs: mockFs,
    });

  async function executeAtVirtualTimeout(
    executor: ToolExecutorImpl,
    timeoutMs: number,
    options: Parameters<ToolExecutorImpl['execute']>[0],
  ) {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const pendingResult = executor.execute(options);
      await vi.advanceTimersByTimeAsync(TIMEOUT_RETURN_MS(timeoutMs));
      return {
        result: await pendingResult,
        elapsed: Date.now() - start,
      };
    } finally {
      vi.useRealTimers();
    }
  }

  it('uses tool.defaultTimeoutMs when options.timeoutMs is absent', async () => {
    const TIMEOUT_MS = 500;
    registry.register(makeSlowTool(TIMEOUT_MS));
    const executor = new ToolExecutorImpl(registry, 60_000);

    const { result, elapsed } = await executeAtVirtualTimeout(executor, TIMEOUT_MS, {
      toolName: 'slow', args: {}, ctx: makeCtx(),
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('execution limit');
    expect(elapsed).toBe(TIMEOUT_RETURN_MS(TIMEOUT_MS));
  });

  it('uses options.timeoutMs over tool.defaultTimeoutMs', async () => {
    const TIMEOUT_MS = 100;
    registry.register(makeSlowTool(500));  // tool default 故意更长、验 options.timeoutMs 真 override
    const executor = new ToolExecutorImpl(registry, 60_000);

    const { result, elapsed } = await executeAtVirtualTimeout(executor, TIMEOUT_MS, {
      toolName: 'slow',
      args: {},
      ctx: makeCtx(),
      timeoutMs: TIMEOUT_MS,
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('execution limit');
    expect(elapsed).toBe(TIMEOUT_RETURN_MS(TIMEOUT_MS));
  });

  it('falls back to executor.defaultTimeoutMs when neither tool nor options declare timeout', async () => {
    const TIMEOUT_MS = 300;
    registry.register(makeSlowTool(undefined));
    const executor = new ToolExecutorImpl(registry, TIMEOUT_MS);

    const { result, elapsed } = await executeAtVirtualTimeout(executor, TIMEOUT_MS, {
      toolName: 'slow', args: {}, ctx: makeCtx(),
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('execution limit');
    expect(elapsed).toBe(TIMEOUT_RETURN_MS(TIMEOUT_MS));
  });
});
