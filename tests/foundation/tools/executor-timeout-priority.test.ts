import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { ToolExecutorImpl } from '../../../src/foundation/tools/executor.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { Tool } from '../../../src/foundation/tool-protocol/index.js';

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

  it('uses tool.defaultTimeoutMs when options.timeoutMs is absent', async () => {
    const TIMEOUT_MS = 500;
    registry.register(makeSlowTool(TIMEOUT_MS));
    const executor = new ToolExecutorImpl(registry, 60_000);

    const start = Date.now();
    const result = await executor.execute({ toolName: 'slow', args: {}, ctx: makeCtx() });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.content).toContain('timed out');
    // phase 1164: 表达「断言 = TIMEOUT_MS ± margin」derivation、替原 magic 400/900
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 100);  // setup overhead margin
    expect(elapsed).toBeLessThan(TIMEOUT_MS + 400);            // contention safety margin
  });

  it('uses options.timeoutMs over tool.defaultTimeoutMs', async () => {
    const TIMEOUT_MS = 100;
    registry.register(makeSlowTool(500));  // tool default 故意更长、验 options.timeoutMs 真 override
    const executor = new ToolExecutorImpl(registry, 60_000);

    const start = Date.now();
    const result = await executor.execute({
      toolName: 'slow',
      args: {},
      ctx: makeCtx(),
      timeoutMs: TIMEOUT_MS,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.content).toContain('timed out');
    // phase 1164: 替原 magic 50/300
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);   // setup overhead margin
    expect(elapsed).toBeLessThan(TIMEOUT_MS + 200);            // contention safety margin
  });

  it('falls back to executor.defaultTimeoutMs when neither tool nor options declare timeout', async () => {
    const TIMEOUT_MS = 300;
    registry.register(makeSlowTool(undefined));
    const executor = new ToolExecutorImpl(registry, TIMEOUT_MS);

    const start = Date.now();
    const result = await executor.execute({ toolName: 'slow', args: {}, ctx: makeCtx() });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.content).toContain('timed out');
    // phase 1164: 替原 magic 200/600
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 100);  // setup overhead margin
    expect(elapsed).toBeLessThan(TIMEOUT_MS + 300);            // contention safety margin
  });
});
