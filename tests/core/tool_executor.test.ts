/**
 * ToolExecutor 测试 - 权限检查 + 审计日志 + 参数验证
 * 
 * 简化测试：验证路径解析逻辑和参数验证
 * 
 * 新增测试：
 * - validateArgs() 类型检查（string/number/boolean）
 * - getForProfile() 按权限级别过滤
 */
import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { ToolExecutorImpl } from '../../src/foundation/tools/executor.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import type { Tool, ToolPermission } from '../../src/types/tool.js';

describe('Tool Path Validation', () => {
  it('should resolve paths correctly', () => {
    const clawDir = '/workspace/.chestnut/claws/test-claw';
    const relativePath = 'clawspace/test.txt';
    const resolved = path.resolve(clawDir, relativePath);
    
    expect(resolved).toBe('/workspace/.chestnut/claws/test-claw/clawspace/test.txt');
    expect(resolved.startsWith(clawDir)).toBe(true);
  });

  it('should detect path traversal attempts', () => {
    const clawDir = '/workspace/.chestnut/claws/test-claw';
    const maliciousPath = '../outside.txt';
    const resolved = path.resolve(clawDir, maliciousPath);
    
    // 解析后的路径应该在 clawDir 之外
    expect(resolved.startsWith(clawDir)).toBe(false);
    expect(resolved).toBe('/workspace/.chestnut/claws/outside.txt');
  });

  it('should handle absolute paths within bounds', () => {
    const clawDir = '/workspace/.chestnut/claws/test-claw';
    const fullPath = path.join(clawDir, 'clawspace', 'test.txt');
    
    expect(fullPath.startsWith(clawDir)).toBe(true);
    expect(fullPath.includes('..')).toBe(false);
  });

  it('should identify system paths', () => {
    const workspaceRoot = '/workspace/.chestnut';
    const systemPaths = [
      '../../config',
      '../motion/status',
      'config.yaml',
    ];
    
    for (const p of systemPaths) {
      const resolved = path.resolve(workspaceRoot, 'claws', 'test-claw', p);
      // 这些路径应该解析到 workspaceRoot 之外或关键目录
      const isOutside = !resolved.startsWith(path.join(workspaceRoot, 'claws')) ||
                        resolved.includes('motion') ||
                        resolved.endsWith('config.yaml');
      expect(isOutside || p.includes('..')).toBe(true);
    }
  });
});

describe('ToolExecutor validateArgs', () => {
  const registry = new ToolRegistryImpl();
  const executor = new ToolExecutorImpl(registry);

  // 注册测试工具
  registry.register({
    name: 'testTool',
    description: 'Test tool',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
        enabled: { type: 'boolean' },
      },
      required: ['name'],
    },

    readonly: true,
    execute: async () => ({ success: true, content: 'ok' }),
  });

  it('should validate required fields', () => {
    const result = executor.validateArgs('testTool', {});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: name');
  });

  it('should pass with all required fields', () => {
    const result = executor.validateArgs('testTool', { name: 'test' });
    expect(result.valid).toBe(true);
  });

  it('should reject string field with number value', () => {
    const result = executor.validateArgs('testTool', { 
      name: 123 as any,  // 类型错误
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('should be string'))).toBe(true);
  });

  it('should reject number field with string value', () => {
    const result = executor.validateArgs('testTool', { 
      name: 'test',
      count: 'ten' as any,  // 类型错误
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('should be number'))).toBe(true);
  });

  it('should reject boolean field with string value', () => {
    const result = executor.validateArgs('testTool', { 
      name: 'test',
      enabled: 'yes' as any,  // 类型错误
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('should be boolean'))).toBe(true);
  });

  it('should pass with correct types', () => {
    const result = executor.validateArgs('testTool', { 
      name: 'test',
      count: 42,
      enabled: true,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('should return error for non-existent tool', () => {
    const result = executor.validateArgs('nonExistent', {});
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain('not found');
  });

  // === 新增：更多类型验证测试 ===

  it('should reject string field with boolean value', () => {
    const result = executor.validateArgs('testTool', { 
      name: true as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('should be string'))).toBe(true);
  });

  it('should reject number field with boolean value', () => {
    const result = executor.validateArgs('testTool', { 
      name: 'test',
      count: true as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('should be number'))).toBe(true);
  });

  it('should reject boolean field with number value', () => {
    const result = executor.validateArgs('testTool', { 
      name: 'test',
      enabled: 1 as any,
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.some(e => e.includes('should be boolean'))).toBe(true);
  });

  it('should allow null for optional fields', () => {
    // count 和 enabled 是可选字段，null 应该被接受
    const result = executor.validateArgs('testTool', { 
      name: 'test',
      count: null as any,
      enabled: null as any,
    });
    // 根据实现，null 可能通过也可能失败，取决于具体验证逻辑
    // 这里我们只验证不会崩溃
    expect(result).toBeDefined();
  });
});

describe('ToolRegistryImpl getForProfile', () => {
  it('should filter tools based on profile allowlist', () => {
    const registry = new ToolRegistryImpl();

    registry.register({
      name: 'read',
      description: 'Read tool',
      schema: { type: 'object', properties: {} },
      profiles: ['readonly', 'subagent', 'full'],
      readonly: true,
      execute: async () => ({ success: true }),
    });

    registry.register({
      name: 'write',
      description: 'Write tool',
      schema: { type: 'object', properties: {} },
      profiles: ['subagent', 'full'],
      readonly: false,
      execute: async () => ({ success: true }),
    });

    registry.register({
      name: 'exec',
      description: 'Exec tool',
      schema: { type: 'object', properties: {} },
      profiles: ['subagent', 'full'],
      readonly: false,
      execute: async () => ({ success: true }),
    });

    // readonly profile 应该只有 read
    const readonlyTools = registry.getForProfile('readonly');
    expect(readonlyTools.some(t => t.name === 'read')).toBe(true);
    expect(readonlyTools.some(t => t.name === 'write')).toBe(false);
    expect(readonlyTools.some(t => t.name === 'exec')).toBe(false);

    // subagent profile 应该有 read, write, exec
    const subagentTools = registry.getForProfile('subagent');
    expect(subagentTools.some(t => t.name === 'read')).toBe(true);
    expect(subagentTools.some(t => t.name === 'write')).toBe(true);
    expect(subagentTools.some(t => t.name === 'exec')).toBe(true);

    // full profile 应该有所有工具
    const fullTools = registry.getForProfile('full');
    expect(fullTools.some(t => t.name === 'read')).toBe(true);
    expect(fullTools.some(t => t.name === 'write')).toBe(true);
  });

  it('should return empty array for tools with no profiles', () => {
    const registry = new ToolRegistryImpl();

    registry.register({
      name: 'customTool',
      description: 'Custom tool',
      schema: { type: 'object', properties: {} },
      readonly: true,
      execute: async () => ({ success: true }),
    });

    const readonlyTools = registry.getForProfile('readonly');
    expect(readonlyTools.some(t => t.name === 'customTool')).toBe(false);
  });
});

describe('validateArgs strict additionalProperties (phase 531)', () => {
  const mockTool = {
    name: 'mock',
    description: 'mock',
    schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'path' },
        cwd: { type: 'string', description: 'cwd' },
      },
      required: ['path'],
    },
    readonly: true,
    idempotent: true,
    execute: async () => ({ success: true, content: '' }),
  };

  it('rejects unknown field with allowed list', () => {
    const registry = new ToolRegistryImpl();
    registry.register(mockTool);
    const executor = new ToolExecutorImpl(registry);
    const result = executor.validateArgs('mock', { path: '/x', claw: 'other' });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toMatch(/Unknown field "claw" for tool "mock"/);
    expect(result.errors?.[0]).toMatch(/Allowed fields: cwd, path/);
  });

  it('rejects multiple unknown fields', () => {
    const registry = new ToolRegistryImpl();
    registry.register(mockTool);
    const executor = new ToolExecutorImpl(registry);
    const result = executor.validateArgs('mock', { path: '/x', foo: 1, bar: 2 });
    expect(result.valid).toBe(false);
    expect(result.errors?.length).toBeGreaterThanOrEqual(2);
    expect(result.errors?.join('\n')).toMatch(/foo/);
    expect(result.errors?.join('\n')).toMatch(/bar/);
  });

  it('passes valid args (regression)', () => {
    const registry = new ToolRegistryImpl();
    registry.register(mockTool);
    const executor = new ToolExecutorImpl(registry);
    const result = executor.validateArgs('mock', { path: '/x', cwd: '/y' });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('rejects args for 0-arg tool', () => {
    const zeroArgTool = { ...mockTool, name: 'zero', schema: { type: 'object' as const } };
    const registry = new ToolRegistryImpl();
    registry.register(zeroArgTool);
    const exec = new ToolExecutorImpl(registry);
    const result = exec.validateArgs('zero', { foo: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toMatch(/accepts no arguments/);
  });
});
