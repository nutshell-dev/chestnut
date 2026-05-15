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
    registry.register(makeSlowTool(500));
    const executor = new ToolExecutorImpl(registry, 60_000);

    const start = Date.now();
    const result = await executor.execute({ toolName: 'slow', args: {}, ctx: makeCtx() });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.content).toContain('timed out');
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(900);
  });

  it('uses options.timeoutMs over tool.defaultTimeoutMs', async () => {
    registry.register(makeSlowTool(500));
    const executor = new ToolExecutorImpl(registry, 60_000);

    const start = Date.now();
    const result = await executor.execute({
      toolName: 'slow',
      args: {},
      ctx: makeCtx(),
      timeoutMs: 100,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.content).toContain('timed out');
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(300);
  });

  it('falls back to executor.defaultTimeoutMs when neither tool nor options declare timeout', async () => {
    registry.register(makeSlowTool(undefined));
    const executor = new ToolExecutorImpl(registry, 300);

    const start = Date.now();
    const result = await executor.execute({ toolName: 'slow', args: {}, ctx: makeCtx() });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.content).toContain('timed out');
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(600);
  });
});
