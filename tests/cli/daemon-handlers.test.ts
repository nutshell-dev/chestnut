import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAuditWrite = vi.fn();

vi.mock('../../src/foundation/fs/node-fs.js', () => ({
  NodeFileSystem: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/foundation/audit/index.js', () => ({
  createSystemAudit: vi.fn(() => ({
    write: mockAuditWrite,
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  })),
  AUDIT_FILE: 'audit.tsv',
}));

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getClawDir: vi.fn(() => '/tmp/test-claw'),
    getNamedSubrootDir: vi.fn(() => '/tmp/test-motion'),
  };
});

// 注：phase 375 后不再需 mock assembly/config-load + daemon/daemon
// （daemon-handlers 不引这两条 heavy 链）

import { constructShimAudit, registerShimHandlers } from '../../src/daemon-handlers.js';

describe('daemon-handlers shim audit', () => {
  let errorSpy: vi.SpyInstance;
  let mockExit: vi.SpyInstance;
  let shimAudit: ReturnType<typeof constructShimAudit>;

  beforeEach(() => {
    mockAuditWrite.mockClear();
    mockAuditWrite.mockImplementation(() => {}); // 默 noop
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);

    // 每 test 全新 audit + handler 注册（旧 module-level state 取消）
    shimAudit = constructShimAudit('test-claw');
    registerShimHandlers(shimAudit);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    mockExit.mockRestore();

    // 清本 test 注册 handler（用 sentinel 子串匹配、保 vitest 原有 listener）
    const isOurUncaught = (h: any) => h.toString().includes('UNCAUGHT_EXCEPTION');
    const isOurUnhandled = (h: any) => h.toString().includes('UNHANDLED_REJECTION');
    process.listeners('uncaughtException').filter(isOurUncaught).forEach(h => process.removeListener('uncaughtException', h));
    process.listeners('unhandledRejection').filter(isOurUnhandled).forEach(h => process.removeListener('unhandledRejection', h));
  });

  it('constructShimAudit 有效 argv → 返非空 AuditLog', () => {
    expect(shimAudit).not.toBeNull();
  });

  it('constructShimAudit 无效 argv → 返 null', () => {
    expect(constructShimAudit('..')).toBeNull();
    expect(constructShimAudit('/abs')).toBeNull();
    expect(constructShimAudit('')).toBeNull();
    expect(constructShimAudit(undefined)).toBeNull();
  });

  it('registerShimHandlers 注册 uncaught + unhandled', () => {
    const uncaughtHandlers = process.listeners('uncaughtException');
    const unhandledHandlers = process.listeners('unhandledRejection');
    expect(uncaughtHandlers.length).toBeGreaterThanOrEqual(1);
    expect(unhandledHandlers.length).toBeGreaterThanOrEqual(1);
  });

  it('uncaughtException → audit daemon_uncaught_exception + console + exit(1)', () => {
    const handler = process.listeners('uncaughtException').find(
      h => h.toString().includes('UNCAUGHT_EXCEPTION')
    );
    expect(handler).toBeDefined();

    const testErr = new Error('test shim uncaught');
    testErr.stack = 'mock-stack';

    expect(() => handler!(testErr)).toThrow('process.exit(1)');
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'daemon_uncaught_exception',
      expect.stringContaining('error=test shim uncaught'),
    );
    expect(errorSpy).toHaveBeenCalledWith('[daemon] Uncaught exception:', testErr);
  });

  it('unhandledRejection → audit daemon_unhandled_rejection + console + exit(1)', () => {
    const handler = process.listeners('unhandledRejection').find(
      h => h.toString().includes('UNHANDLED_REJECTION')
    );
    expect(handler).toBeDefined();

    const reason = 'test rejection';
    expect(() => handler!(reason)).toThrow('process.exit(1)');
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'daemon_unhandled_rejection',
      expect.stringContaining('error=test rejection'),
    );
    expect(errorSpy).toHaveBeenCalledWith('[daemon] Unhandled rejection:', reason);
  });

  it('audit write 抛 → 静默 fallback console（uncaught path）', () => {
    mockAuditWrite.mockImplementation(() => {
      throw new Error('audit disk full');
    });

    const handler = process.listeners('uncaughtException').find(
      h => h.toString().includes('UNCAUGHT_EXCEPTION')
    );
    expect(handler).toBeDefined();

    const testErr = new Error('test write throw');
    expect(() => handler!(testErr)).toThrow('process.exit(1)');
    expect(mockAuditWrite).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('[daemon] Uncaught exception:', testErr);
  });
});
