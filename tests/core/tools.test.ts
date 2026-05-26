/**
 * Tools module tests
 *
 * Tests:
 * - ToolRegistryImpl: register, get, profile filtering
 * - ToolExecutor: execute with permissions, timeout, errors
 * - ExecContext: permissions, elapsed time
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { ToolExecutorImpl } from '../../src/foundation/tools/executor.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import type { Tool, ToolResult } from '../../src/foundation/tool-protocol/index.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import {
  ToolNotFoundError,
  ToolTimeoutError,
  ToolInvalidInputError,
} from '../../src/foundation/errors.js';

describe('Tools', () => {
  describe('ToolRegistryImpl', () => {
    let registry: ToolRegistryImpl;

    beforeEach(() => {
      registry = new ToolRegistryImpl();
    });

    it('should register and retrieve tool', () => {
      const mockTool: Tool = {
        name: 'test-tool',
        description: 'A test tool',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => ({ success: true, content: 'ok' }),
      };

      registry.register(mockTool);

      const retrieved = registry.get('test-tool');
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('test-tool');
    });

    it('should overwrite tool with same name', () => {
      const tool1: Tool = {
        name: 'same',
        description: 'First',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => ({ success: true, content: 'v1' }),
      };

      const tool2: Tool = {
        name: 'same',
        description: 'Second',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => ({ success: true, content: 'v2' }),
      };

      registry.register(tool1);
      registry.register(tool2);

      const retrieved = registry.get('same');
      expect(retrieved?.description).toBe('Second');
    });

    it('should check tool existence with has()', () => {
      const mockTool: Tool = {
        name: 'exists',
        description: 'Test',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => ({ success: true, content: '' }),
      };

      registry.register(mockTool);

      expect(registry.has('exists')).toBe(true);
      expect(registry.has('missing')).toBe(false);
    });

    it('should unregister tool', () => {
      const mockTool: Tool = {
        name: 'to-remove',
        description: 'Test',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => ({ success: true, content: '' }),
      };

      registry.register(mockTool);
      expect(registry.has('to-remove')).toBe(true);

      registry.unregister('to-remove');
      expect(registry.has('to-remove')).toBe(false);
    });

    it('should get all tools', () => {
      registry.register({
        name: 'tool-a',
        description: 'A',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => ({ success: true, content: '' }),
      });

      registry.register({
        name: 'tool-b',
        description: 'B',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => ({ success: true, content: '' }),
      });

      const all = registry.getAll();
      expect(all).toHaveLength(2);
    });

    it('should filter tools by profile', () => {
      const readonlyNames = ['read', 'search', 'ls', 'status', 'memory_search'];
      readonlyNames.forEach(name => {
        registry.register({
          name,
          description: `Tool ${name}`,
          schema: { type: 'object' },
          profiles: ['readonly', 'full'],
          readonly: true,
          execute: async () => ({ success: true, content: '' }),
        });
      });

      registry.register({
        name: 'write',
        description: 'Write tool',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: false,
        execute: async () => ({ success: true, content: '' }),
      });

      const readonlyTools = registry.getForProfile('readonly');
      expect(readonlyTools).toHaveLength(5);
      expect(readonlyTools.every(t => t.profiles.includes('readonly'))).toBe(true);
      expect(readonlyTools.some(t => t.name === 'write')).toBe(false);
    });

    it('should format tools for LLM API', () => {
      registry.register({
        name: 'read',
        description: 'Read a file',
        schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        profiles: ['full'],
        readonly: true,
        execute: async () => ({ success: true, content: '' }),
      });

      const formatted = registry.formatForLLM(registry.getAll());

      expect(formatted).toHaveLength(1);
      expect(formatted[0]).toEqual({
        name: 'read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      });
    });
  });

  describe('ExecContext', () => {
    const mockFs = {} as FileSystem;

    it('should track elapsed time', async () => {
      const ctx = new ExecContextImpl({
        clawId: 'test',
        clawDir: '/test',
        profile: 'full',
        allowedGroups: new Set(['fs-read']),
        callerLabel: 'claw',
        fs: mockFs,
      });

      const elapsed1 = ctx.getElapsedMs();
      await new Promise(r => setTimeout(r, 10));
      const elapsed2 = ctx.getElapsedMs();

      expect(elapsed1).toBeGreaterThanOrEqual(0);
      expect(elapsed2).toBeGreaterThan(elapsed1);
    });
  });

  describe('ToolExecutor', () => {
    let registry: ToolRegistryImpl;
    let executor: ToolExecutorImpl;
    let mockFs: FileSystem;

    beforeEach(() => {
      registry = new ToolRegistryImpl();
      executor = new ToolExecutorImpl(registry, 60000, vi.fn().mockResolvedValue('mock-task-id'));
      mockFs = {} as FileSystem;
    });

    it('should throw ToolNotFoundError for unknown tool', async () => {
      const ctx = new ExecContextImpl({
        clawId: 'test',
        clawDir: '/test',
        profile: 'full',
        allowedGroups: new Set(['fs-read']),
        callerLabel: 'claw',
        fs: mockFs,
      });

      await expect(
        executor.execute({ toolName: 'unknown', args: {}, ctx })
      ).rejects.toThrow(ToolNotFoundError);
    });

    it('should execute tool successfully', async () => {
      const mockExecute = vi.fn(async (): Promise<ToolResult> => ({
        success: true,
        content: 'executed',
      }));

      registry.register({
        name: 'test',
        description: 'Test tool',
        schema: { type: 'object', properties: { key: { type: 'string' } } },
        profiles: ['full'],
        readonly: true,
        execute: mockExecute,
      });

      const ctx = new ExecContextImpl({
        clawId: 'test',
        clawDir: '/test',
        profile: 'full',
        allowedGroups: new Set(['fs-read']),
        callerLabel: 'claw',
        fs: mockFs,
      });

      const result = await executor.execute({
        toolName: 'test',
        args: { key: 'value' },
        ctx,
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe('executed');
      const call = mockExecute.mock.calls[0];
      expect(call[0]).toEqual({ key: 'value' });
      expect(call[1].clawId).toBe('test');
      expect(call[1].clawDir).toBe('/test');
      expect(call[1].profile).toBe('full');
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    });

    it('should throw ToolTimeoutError on timeout', async () => {
      registry.register({
        name: 'slow',
        description: 'Slow tool',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => {
          await new Promise(r => setTimeout(r, 500)); // sleep: mock slow tool execution
          return { success: true, content: '' };
        },
      });

      const ctx = new ExecContextImpl({
        clawId: 'test',
        clawDir: '/test',
        profile: 'full',
        allowedGroups: new Set(['fs-read']),
        callerLabel: 'claw',
        fs: mockFs,
      });

      const promise = executor.execute({
        toolName: 'slow',
        args: {},
        ctx,
        timeoutMs: 50,
      });

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.content).toContain('timed out');
    });

    it('should return error result (not re-throw) when tool throws a regular error', async () => {
      registry.register({
        name: 'explosive',
        description: 'Tool that always throws',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => {
          throw new Error('something went badly wrong');
        },
      });

      const ctx = new ExecContextImpl({
        clawId: 'test',
        clawDir: '/test',
        profile: 'full',
        allowedGroups: new Set(['fs-read']),
        callerLabel: 'claw',
        fs: mockFs,
      });

      const result = await executor.execute({
        toolName: 'explosive',
        args: {},
        ctx,
      });

      expect(result.success).toBe(false);
      expect(result.content).toContain('something went badly wrong');
    });

    it('should execute readonly tools in parallel', async () => {
      const executionOrder: number[] = [];

      registry.register({
        name: 'tool1',
        description: 'Tool 1',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => {
          executionOrder.push(1);
          await new Promise(r => setTimeout(r, 10));
          executionOrder.push(-1);
          return { success: true, content: '1' };
        },
      });

      registry.register({
        name: 'tool2',
        description: 'Tool 2',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => {
          executionOrder.push(2);
          await new Promise(r => setTimeout(r, 10));
          executionOrder.push(-2);
          return { success: true, content: '2' };
        },
      });

      registry.register({
        name: 'tool3',
        description: 'Tool 3',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        execute: async () => {
          executionOrder.push(3);
          await new Promise(r => setTimeout(r, 10));
          executionOrder.push(-3);
          return { success: true, content: '3' };
        },
      });

      const ctx = new ExecContextImpl({
        clawId: 'test',
        clawDir: '/test',
        profile: 'full',
        allowedGroups: new Set(['fs-read']),
        callerLabel: 'claw',
        fs: mockFs,
      });

      const results = await executor.executeParallel(
        [
          { toolName: 'tool1', args: {} },
          { toolName: 'tool2', args: {} },
          { toolName: 'tool3', args: {} },
        ],
        ctx
      );

      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);

      const starts = executionOrder.filter(n => n > 0);
      const ends = executionOrder.filter(n => n < 0);

      expect(starts).toHaveLength(3);
      expect(ends).toHaveLength(3);
    });

    it('should throw ToolInvalidInputError when required schema field is missing', async () => {
      registry.register({
        name: 'strict',
        description: 'Needs path',
        schema: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
        profiles: ['full'],
        readonly: true,
        idempotent: true,
        execute: async () => ({ success: true, content: 'ok' }),
      });

      const ctx = new ExecContextImpl({
        clawId: 'test',
        clawDir: '/test',
        profile: 'full',
        allowedGroups: new Set(['fs-read']),
        callerLabel: 'claw',
        fs: mockFs,
      });

      await expect(
        executor.execute({ toolName: 'strict', args: {}, ctx })
      ).rejects.toThrow(ToolInvalidInputError);
    });

    it('should return success when async=true (fs-driven, no taskSystem needed)', async () => {
      registry.register({
        name: 'async-capable',
        description: 'Supports async',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        idempotent: true,
        supportsAsync: true,
        group: 'fs-read',
        execute: async () => ({ success: true, content: 'sync result' }),
      });

      const ctx = new ExecContextImpl({
        clawId: 'test',
        clawDir: '/test',
        profile: 'full',
        allowedGroups: new Set(['fs-read']),
        callerLabel: 'claw',
        fs: {
          ...mockFs,
          writeAtomic: vi.fn().mockResolvedValue(undefined),
        } as unknown as FileSystem,
      });

      const result = await executor.execute({
        toolName: 'async-capable',
        args: {},
        ctx,
        async: true,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('Async task queued');
      expect(result.metadata?.taskId).toBeDefined();
      expect(result.metadata?.async).toBe(true);
    });

    it('should return error result when async=true but tool does not support async', async () => {
      registry.register({
        name: 'no-async',
        description: 'No async support',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: false,
        idempotent: false,
        supportsAsync: false,
        group: 'fs-read',
        execute: async () => ({ success: true, content: 'sync' }),
      });

      const mockTaskSystem = {
        scheduleTool: vi.fn().mockResolvedValue('task-id-123'),
      } as unknown as import('../../src/core/async-task-system/system.js').AsyncTaskSystem;
      (executor as any).taskSystem = mockTaskSystem;

      const ctx = new ExecContextImpl({
        clawId: 'test',
        clawDir: '/test',
        profile: 'full',
        allowedGroups: new Set(['fs-read']),
        callerLabel: 'claw',
        fs: mockFs,
      });

      const result = await executor.execute({
        toolName: 'no-async',
        args: {},
        ctx,
        async: true,
      });

      expect(result.success).toBe(false);
      expect(result.content).toContain('does not support async');
    });

    it('should write pending file and return taskId when async=true with supporting tool', async () => {
      registry.register({
        name: 'long-task',
        description: 'Long running task',
        schema: { type: 'object', properties: { key: { type: 'string' } } },
        profiles: ['full'],
        readonly: false,
        idempotent: true,
        supportsAsync: true,
        group: 'fs-read',
        execute: async () => ({ success: true, content: 'done' }),
      });

      const ctx = new ExecContextImpl({
        clawId: 'test',
        clawDir: '/test',
        profile: 'full',
        allowedGroups: new Set(['fs-read']),
        callerLabel: 'claw',
        fs: {
          ...mockFs,
          writeAtomic: vi.fn().mockResolvedValue(undefined),
        } as unknown as FileSystem,
      });

      const result = await executor.execute({
        toolName: 'long-task',
        args: { key: 'value' },
        ctx,
        async: true,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('Async task queued');
      expect(result.metadata?.taskId).toBeDefined();
      expect(result.metadata?.async).toBe(true);
    });

    it('should return null for non-readonly tools in executeParallel mixed batch', async () => {
      registry.register({
        name: 'read-op',
        description: 'Read',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: true,
        idempotent: true,
        execute: async () => ({ success: true, content: 'read-result' }),
      });

      registry.register({
        name: 'write-op',
        description: 'Write',
        schema: { type: 'object' },
        profiles: ['full'],
        readonly: false,
        idempotent: false,
        execute: async () => ({ success: true, content: 'write-result' }),
      });

      const ctx = new ExecContextImpl({
        clawId: 'test',
        clawDir: '/test',
        profile: 'full',
        allowedGroups: new Set(['fs-read']),
        callerLabel: 'claw',
        fs: mockFs,
      });

      const results = await executor.executeParallel(
        [
          { toolName: 'read-op', args: {} },
          { toolName: 'write-op', args: {} },
        ],
        ctx
      );

      expect(results).toHaveLength(2);
      expect(results[0]).not.toBeNull();
      expect(results[0]!.content).toBe('read-result');
      expect(results[1]).toBeNull();
    });
  });
});
