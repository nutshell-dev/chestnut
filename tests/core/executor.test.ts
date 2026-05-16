/**
 * Tool Executor tests - Phase 2 质量审查补充
 * 
 * 覆盖 audit.tsv TSV 记录功能（设计缺口 C）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { ToolExecutorImpl } from '../../src/foundation/tools/executor.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';

describe('ToolExecutor', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let ctx: ExecContextImpl;
  let registry: ToolRegistryImpl;
  let executor: ToolExecutorImpl;
  let auditWriter: AuditWriter;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    auditWriter = new AuditWriter(mockFs, 'audit.tsv');
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      profile: 'full',
      fs: mockFs,
      auditWriter,
    });
    registry = new ToolRegistryImpl();
    executor = new ToolExecutorImpl(registry);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // Phase 17: executeParallel
  describe('executeParallel', () => {
    it('should execute batch of readonly tools in parallel and return results in original order', async () => {
      registry.register({
        name: 'echo-a',
        description: 'echo a',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: true,
        async execute() { return { success: true, content: 'result-a' }; },
      });
      registry.register({
        name: 'echo-b',
        description: 'echo b',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: true,
        async execute() { return { success: true, content: 'result-b' }; },
      });

      const results = await executor.executeParallel(
        [{ toolName: 'echo-b', args: {} }, { toolName: 'echo-a', args: {} }],
        ctx,
      );

      expect(results).toHaveLength(2);
      expect(results[0].content).toBe('result-b');
      expect(results[1].content).toBe('result-a');
    });

    it('should return null for non-readonly tools in mixed batch', async () => {
      registry.register({
        name: 'write-tool',
        description: 'write',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: false,
        async execute() { return { success: true, content: 'written' }; },
      });
      registry.register({
        name: 'read-tool',
        description: 'read',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: true,
        async execute() { return { success: true, content: 'read-result' }; },
      });

      // batch has 2 items: non-readonly returns null, readonly returns result
      const results = await executor.executeParallel(
        [{ toolName: 'write-tool', args: {} }, { toolName: 'read-tool', args: {} }],
        ctx,
      );

      expect(results).toHaveLength(2);
      expect(results[0]).toBeNull();
      expect(results[1]).not.toBeNull();
      expect(results[1]!.content).toBe('read-result');
    });

    it('should return all results for all-readonly batch', async () => {
      registry.register({
        name: 'r1',
        description: 'r1',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: true,
        async execute() { return { success: true, content: 'a' }; },
      });
      registry.register({
        name: 'r2',
        description: 'r2',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: true,
        async execute() { return { success: true, content: 'b' }; },
      });

      const results = await executor.executeParallel(
        [{ toolName: 'r1', args: {} }, { toolName: 'r2', args: {} }],
        ctx,
      );

      expect(results).toHaveLength(2);
      expect(results.every(r => r !== null)).toBe(true);
      expect(results[0]!.content).toBe('a');
      expect(results[1]!.content).toBe('b');
    });

    it('should return null for non-readonly at any position', async () => {
      registry.register({
        name: 'read-tool',
        description: 'read',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: true,
        async execute() { return { success: true, content: 'r' }; },
      });
      registry.register({
        name: 'write-tool',
        description: 'write',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: false,
        async execute() { return { success: true, content: 'w' }; },
      });

      const results = await executor.executeParallel(
        [{ toolName: 'read-tool', args: {} }, { toolName: 'write-tool', args: {} }],
        ctx,
      );

      expect(results).toHaveLength(2);
      expect(results[0]).not.toBeNull();
      expect(results[0]!.content).toBe('r');
      expect(results[1]).toBeNull();
    });

    it('should return error result when readonly tool throws', async () => {
      registry.register({
        name: 'exploding-tool',
        description: 'explodes',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: true,
        async execute() { throw new Error('boom'); },
      });

      const results = await executor.executeParallel(
        [{ toolName: 'exploding-tool', args: {} }],
        ctx,
      );

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].content).toContain('boom');
    });
  });

  // Phase 534: validateArgs nested validation
  describe('validateArgs', () => {
    const nestedTool = {
      name: 'nested-test',
      description: 'Nested schema test',
      schema: {
        type: 'object' as const,
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                count: { type: 'number' },
              },
              required: ['name'],
            },
          },
          tag: { type: 'string' },
        },
        required: ['items'],
      },
      readonly: true,
      async execute() { return { success: true, content: '' }; },
    };

    beforeEach(() => {
      registry.register(nestedTool);
    });

    it('should validate nested array item types', () => {
      const result = executor.validateArgs('nested-test', {
        items: [{ name: 123 }],  // name should be string
      });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('items[0].name');
      expect(result.errors?.[0]).toContain('should be string');
    });

    it('should validate nested object required fields', () => {
      const result = executor.validateArgs('nested-test', {
        items: [{ count: 1 }],  // missing required 'name'
      });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('items[0].name');
      expect(result.errors?.[0]).toContain('Missing required');
    });

    it('should pass valid nested data', () => {
      const result = executor.validateArgs('nested-test', {
        items: [{ name: 'a', count: 1 }],
        tag: 'x',
      });
      expect(result.valid).toBe(true);
    });

    it('should pass empty array for array field', () => {
      const result = executor.validateArgs('nested-test', {
        items: [],
      });
      expect(result.valid).toBe(true);
    });

    it('should report full path in nested errors', () => {
      const result = executor.validateArgs('nested-test', {
        items: [{ name: 'ok' }, { name: 42 }],  // items[1].name type mismatch
      });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toMatch(/items\[1\]\.name.*should be string.*got number/);
    });

    it('should validate array type mismatch at top level', () => {
      const result = executor.validateArgs('nested-test', {
        items: 'not-an-array',
      });
      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('items');
      expect(result.errors?.[0]).toContain('should be array');
    });
  });

  // Phase 2 质量审查：audit.tsv 测试
  describe('audit logging', () => {
    it('should write audit log on successful tool execution', async () => {
      // Register a simple tool
      registry.register({
        name: 'test-tool',
        description: 'Test tool',
        schema: { type: 'object', properties: { test: { type: 'string' } }, required: [] },

        readonly: true,
        async execute() {
          return { success: true, content: 'ok' };
        },
      });

      await executor.execute({
        toolName: 'test-tool',
        args: { test: 'value' },
        ctx,
      });

      // Check audit.tsv exists
      const auditPath = path.join(tempDir, 'audit.tsv');
      const auditContent = await fs.readFile(auditPath, 'utf-8').catch(() => '');
      
      // TSV format: timestamp, type, toolName, status, duration, summary
      expect(auditContent).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\t/);
      const parts = auditContent.trim().split('\t');
      expect(parts[1]).toBe('tool_exec');
      expect(parts[2]).toBe('test-tool');
      expect(parts[3]).toBe('ok');
      expect(parts[4]).toMatch(/^elapsed_ms=/);
    });

    it('should write audit log on failed tool execution', async () => {
      registry.register({
        name: 'failing-tool',
        description: 'Failing tool',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: true,
        async execute() {
          return { success: false, content: 'Something went wrong' };
        },
      });

      await executor.execute({
        toolName: 'failing-tool',
        args: {},
        ctx,
      });

      const auditPath = path.join(tempDir, 'audit.tsv');
      const auditContent = await fs.readFile(auditPath, 'utf-8').catch(() => '');
      
      expect(auditContent).toBeTruthy();
      const parts = auditContent.trim().split('\t');
      expect(parts[1]).toBe('tool_exec');
      expect(parts[2]).toBe('failing-tool');
      expect(parts[3]).toBe('err');
      expect(parts[5]).toContain('Something went wrong');
    });

    it('should not block execution when audit log fails', async () => {
      // Create auditWriter pointing to non-existent path to simulate failure
      const readonlyDir = path.join(tempDir, 'readonly');
      await fs.mkdir(readonlyDir, { recursive: true });
      await fs.chmod(readonlyDir, 0o555);
      
      const failingAuditWriter = new AuditWriter(mockFs, 'readonly/audit.tsv');
      const readonlyCtx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
        auditWriter: failingAuditWriter,
      });

      registry.register({
        name: 'test-tool',
        description: 'Test tool',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: true,
        async execute() {
          return { success: true, content: 'ok' };
        },
      });

      // Should not throw even though audit log will fail (AuditWriter silently fails)
      const result = await executor.execute({
        toolName: 'test-tool',
        args: {},
        ctx: readonlyCtx,
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe('ok');

      // Restore permissions for cleanup
      await fs.chmod(readonlyDir, 0o755).catch(() => {});
    });

    it('should propagate ctx.signal abort to tool when no options.signal given', async () => {
      // Regression test: Step 2 initially lost ctx.signal in mergedSignal,
      // breaking upstream abort propagation from subagent.
      const abortController = new AbortController();

      registry.register({
        name: 'abortable',
        description: 'Tool that waits for abort signal',
        schema: { type: 'object', properties: {}, required: [] },

        readonly: true,
        async execute(_args, toolCtx) {
          await new Promise<void>((_, reject) => {
            toolCtx.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          return { success: true, content: 'never' };
        },
      });

      const signalCtx = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
        auditWriter,
        signal: abortController.signal,
      });

      const execPromise = executor.execute({
        toolName: 'abortable',
        args: {},
        ctx: signalCtx,
        timeoutMs: 10_000, // long enough that abort wins
      });

      // Abort after a short delay
      setTimeout(() => abortController.abort(), 50);

      const result = await execPromise;
      expect(result.success).toBe(false);
      expect(result.content).toContain('aborted');
    });
  });
});
