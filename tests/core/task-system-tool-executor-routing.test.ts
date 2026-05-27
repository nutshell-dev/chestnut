/**
 * ToolExecutor async routing tests (phase 1303 split from task-system-tool.test.ts)
 *
 * 6 tests covering ToolExecutorImpl async-mode routing behavior:
 * - reject async mode for subagent callerType
 * - return error when tool does not support async
 * - write pending file when taskSystem unavailable
 * - write pending file when tool supports async
 * - reject read tool when async:true (supportsAsync:false)
 * - execute synchronously when async is false
 *
 * Mirror phase 1302 split SOP (top-level describe boundary).
 * Estimated wall: ~150ms (vs combined file mean 2767ms / -95%).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutorImpl } from '../../src/foundation/tools/executor.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import type { Tool, ToolResult, ExecContext } from '../../src/foundation/tool-protocol/index.js';
import { readTool } from '../../src/foundation/file-tool/read.js';

// Mock fs (verbatim copy from task-system-tool.test.ts L96-107)
const createMockFs = () => ({
  read: vi.fn(),
  write: vi.fn().mockResolvedValue(undefined),
  writeAtomic: vi.fn().mockResolvedValue(undefined),
  append: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  move: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(false),
  list: vi.fn().mockResolvedValue([]),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  isDirectory: vi.fn().mockResolvedValue(false),
});

describe('ToolExecutor async routing', () => {
  let registry: ToolRegistryImpl;
  let executor: ToolExecutorImpl;
  let mockTaskSystem: { scheduleTool: ReturnType<typeof vi.fn> };
  let mockCtx: ExecContext;

  beforeEach(() => {
    registry = new ToolRegistryImpl();
    executor = new ToolExecutorImpl(registry, 60000, vi.fn().mockResolvedValue('mock-task-id-123'));

    mockTaskSystem = {
      scheduleTool: vi.fn().mockResolvedValue('mock-task-id-123'),
    };

    mockCtx = {
      clawId: 'test-claw',
      clawDir: '/tmp/test',
      callerType: 'claw',
      allowedGroups: new Set(['fs-read', 'fs-write', 'spawn']),
      callerLabel: 'claw',
      fs: createMockFs() as any,
      profile: { name: 'test', permissions: { read: true, write: true, execute: true, send: true, spawn: true } },
      stepNumber: 1,
      maxSteps: 20,
      getElapsedMs: () => 1000,
      incrementStep: () => {},
    };
  });

  it('should reject async mode for subagent callerType', async () => {
    // Register a tool with supportsAsync: true
    const asyncTool: Tool = {
      name: 'asyncTool',
      description: 'Tool with async support',
      schema: { type: 'object', properties: {} },

      readonly: false,
      idempotent: false,
      supportsAsync: true,
      group: 'spawn',
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'async result' };
      },
    };
    registry.register(asyncTool);

    // Call with async: true and callerType: 'subagent'
    const subagentCtx = { ...mockCtx, callerLabel: 'subagent', allowedGroups: new Set() };
    const result = await executor.execute({
      toolName: 'asyncTool',
      args: {},
      ctx: subagentCtx,
      async: true,
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('not available for this caller');
    expect(mockTaskSystem.scheduleTool).not.toHaveBeenCalled();
  });

  it('should return error when tool does not support async', async () => {
    // Register tool without supportsAsync
    const nonAsyncTool: Tool = {
      name: 'nonAsyncTool',
      description: 'Tool without async support',
      schema: { type: 'object', properties: {} },

      readonly: false,
      idempotent: false,
      group: 'spawn',
      // supportsAsync is undefined (false by default)
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'sync result' };
      },
    };
    registry.register(nonAsyncTool);

    const result = await executor.execute({
      toolName: 'nonAsyncTool',
      args: {},
      ctx: mockCtx,
      async: true, // Request async mode
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('does not support async mode');
    expect(mockTaskSystem.scheduleTool).not.toHaveBeenCalled();
  });

  it('should write pending file when taskSystem is not available (fs-driven)', async () => {
    // phase432: async tool 不再需要 taskSystem，直接从 ctx.fs 写 pending 文件
    const asyncTool: Tool = {
      name: 'asyncTool',
      description: 'Tool with async support',
      schema: { type: 'object', properties: {} },

      readonly: false,
      idempotent: false,
      supportsAsync: true,
      group: 'spawn',
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'async result' };
      },
    };
    registry.register(asyncTool);

    // executor without taskSystem (no longer required)
    (executor as any).taskSystem = undefined;

    const result = await executor.execute({
      toolName: 'asyncTool',
      args: {},
      ctx: mockCtx,
      async: true,
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('Async task queued');
    expect(result.metadata?.taskId).toBeDefined();
    expect(result.metadata?.async).toBe(true);
  });

  it('should write pending file when tool supports async (fs-driven)', async () => {
    // phase432: async tool 改 fs-driven，不再调 taskSystem.scheduleTool
    const asyncTool: Tool = {
      name: 'asyncTool',
      description: 'Tool with async support',
      schema: { type: 'object', properties: { arg1: { type: 'string' } } },

      readonly: false,
      idempotent: false,
      supportsAsync: true,
      group: 'spawn',
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'async result' };
      },
    };
    registry.register(asyncTool);

    const result = await executor.execute({
      toolName: 'asyncTool',
      args: { arg1: 'value1' },
      ctx: mockCtx,
      async: true,
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('Async task queued');
    expect(result.metadata?.taskId).toBeDefined();
    expect(result.metadata?.async).toBe(true);
    expect(mockTaskSystem.scheduleTool).not.toHaveBeenCalled();
  });

  it('should reject read tool when async:true (supportsAsync:false)', async () => {
    // Register real read tool, verify rejected because supportsAsync=false
    registry.register(readTool);

    const result = await executor.execute({
      toolName: 'read',
      args: { path: 'AGENTS.md' },
      ctx: mockCtx,   // mockCtx.taskSystem = mockTaskSystem
      async: true,
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('does not support async');
    expect(mockTaskSystem.scheduleTool).not.toHaveBeenCalled();
  });

  it('should execute synchronously when async is false', async () => {
    const syncTool: Tool = {
      name: 'syncTool',
      description: 'Regular sync tool',
      schema: { type: 'object', properties: {} },

      readonly: false,
      idempotent: false,
      async execute(): Promise<ToolResult> {
        return { success: true, content: 'sync result' };
      },
    };
    registry.register(syncTool);

    const result = await executor.execute({
      toolName: 'syncTool',
      args: {},
      ctx: mockCtx,
      async: false,
    });

    expect(result.success).toBe(true);
    expect(result.content).toBe('sync result');
    expect(mockTaskSystem.scheduleTool).not.toHaveBeenCalled();
  });
});
