import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import {
  createCrossClawReadTool,
  createCrossClawLsTool,
  createCrossClawSearchTool,
} from '../../../src/core/claw-topology/agent-tools.js';
import { CLAW_TOPOLOGY_AUDIT_EVENTS } from '../../../src/core/claw-topology/audit-events.js';
import { readTool, lsTool, searchTool } from '../../../src/foundation/file-tool/index.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import type { ExecContext } from '../../../src/foundation/tools/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { CrossTargetAccess } from '../../../src/core/claw-topology/agent-tools.js';

/**
 * phase 1864 Step G（CT-D10）：测试用跨目标 access capability——
 * 授权主体显式 + 按 target 构造 checker（对象标识与 caller 的不同）。
 */
const crossTargetAccess: CrossTargetAccess = {
  grantedBy: 'test-cross-target',
  createChecker: () => ({
    checkRead: () => {},
    checkWrite: () => {},
    resolveAndCheck: (relPath: string) => relPath,
    prepareWrite: async (relPath: string) => ({
      target: relPath,
      write: async () => {},
      append: async () => {},
    }),
  }),
};

describe('createCrossClawReadTool', () => {
  const mockTopology = {
    enumerate: () => [makeClawId('motion'), 'claw1', 'claw2'],
    resolve: (clawId: string) => {
      if (clawId === makeClawId('motion')) return { kind: 'local', clawDir: '/chestnut/motion' };
      return { kind: 'local', clawDir: `/chestnut/claws/${clawId}` };
    },
    read: vi.fn(),
    readJSON: vi.fn(),
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeBaseCtx(overrides?: Partial<ExecContext>): ExecContext {
    return {
      clawId: 'motion',
      clawDir: '/chestnut/motion',
      clawsDir: '/chestnut/claws',
      workspaceDir: '/chestnut/motion/clawspace',
      syncDir: '/chestnut/motion/sync',

      profile: 'full',
      fs: {} as ExecContext['fs'],
      fsFactory: (dir: string) =>
        ({
          read: vi.fn(),
          baseDir: dir,
        } as unknown as ExecContext['fs']),
      stepNumber: 1,
      maxSteps: 100,
      stopRequested: false,
      requestStop: vi.fn(),
      getElapsedMs: vi.fn().mockReturnValue(0),
      incrementStep: vi.fn(),
      readFileState: new Map(),
      auditWriter: {
        write: vi.fn(),
        preview: vi.fn((s: string) => s),
        message: vi.fn((s: string) => s),
        summary: vi.fn((s: string) => s),
        __brand: 'AuditLog',
      } as unknown as AuditLog,
      ...overrides,
    } as ExecContext;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schema 含 claw 属性', () => {
    const tool = createCrossClawReadTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    expect(tool.schema.properties).toHaveProperty('claw');
    expect(tool.name).toBe(readTool.name);
  });

  it('args.claw === undefined → delegate base tool（同 claw fallback）', async () => {
    const spy = vi.spyOn(readTool, 'execute').mockResolvedValue({ success: true, content: 'hello' });
    const tool = createCrossClawReadTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ path: 'test.txt' }, ctx);
    expect(result).toEqual({ success: true, content: 'hello' });
    expect(spy).toHaveBeenCalledWith({ path: 'test.txt' }, ctx);
  });

  it('args.claw === "<id>" → 改 ctx 调 base、readFileState 不污染 caller、persist 显式 false', async () => {
    const callerReadFileState = new Map();
    const spy = vi.spyOn(readTool, 'execute').mockImplementation(async (_args, passedCtx) => {
      expect(passedCtx.clawDir).toBe('/chestnut/claws/claw1');
      expect(passedCtx.workspaceDir).toBe('/chestnut/claws/claw1/clawspace');
      expect(passedCtx.readFileState).not.toBe(callerReadFileState);
      expect(passedCtx.persistReadFileState).toBe(false);
      expect(passedCtx.fs).toBeDefined();
      return { success: true, content: 'cross-claw content' };
    });
    const tool = createCrossClawReadTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx({ readFileState: callerReadFileState, persistReadFileState: true });
    const result = await tool.execute({ path: 'test.txt', claw: 'claw1' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toBe('cross-claw content');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'test.txt' }),
      expect.anything(),
    );
    // Caller ctx must remain unchanged.
    expect(ctx.persistReadFileState).toBe(true);
  });

  it('phase 1864 Step G（CT-D10）：target ctx 的 permissionChecker 为注入 capability（≠ caller 的）', async () => {
    const callerChecker = makeBaseCtx().permissionChecker;
    let seenChecker: unknown;
    let seenClawDir: string | undefined;
    const spy = vi.spyOn(readTool, 'execute').mockImplementation(async (_args, passedCtx) => {
      seenChecker = passedCtx.permissionChecker;
      seenClawDir = passedCtx.clawDir;
      return { success: true, content: 'cross-claw content' };
    });
    const access: CrossTargetAccess = {
      grantedBy: 'test-cross-target',
      createChecker: ({ clawDir }) => {
        expect(clawDir).toBe('/chestnut/claws/claw1');
        return {
          checkRead: () => {},
          checkWrite: () => {},
          resolveAndCheck: (relPath: string) => relPath,
          prepareWrite: async (relPath: string) => ({
            target: relPath,
            write: async () => {},
            append: async () => {},
          }),
        };
      },
    };
    const tool = createCrossClawReadTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess: access });
    const ctx = makeBaseCtx();
    await tool.execute({ path: 'test.txt', claw: 'claw1' }, ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(seenClawDir).toBe('/chestnut/claws/claw1');
    // 显式 capability：调用形态为 target clawDir + target fs；与 caller 的 checker 不同实例
    expect(seenChecker).toBeDefined();
    expect(seenChecker).not.toBe(callerChecker);
    // caller ctx 未被污染
    expect(ctx.permissionChecker).toBe(callerChecker);
  });

  it('args.claw === "*" → 拒（read 不支持 broadcast）', async () => {
    const tool = createCrossClawReadTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ path: 'test.txt', claw: '*' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('broadcast is not supported by read');
  });

  it('args.claw 无效 → 返回错误', async () => {
    const tool = createCrossClawReadTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ path: 'test.txt', claw: '../bad' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Invalid claw ID');
  });

  it('resolve 失败 → emit audit + 返回错误', async () => {
    const failingTopology = {
      ...mockTopology,
      resolve: vi.fn(() => {
        throw new Error('not_found');
      }),
    };
    const auditSpy = vi.fn();
    const tool = createCrossClawReadTool({ topology: failingTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx({
      auditWriter: { write: auditSpy, preview: vi.fn(), message: vi.fn(), summary: vi.fn(), __brand: 'AuditLog' } as unknown as AuditLog,
    });
    const result = await tool.execute({ path: 'test.txt', claw: 'missing' }, ctx);
    expect(result.success).toBe(false);
    expect(auditSpy).toHaveBeenCalledWith(
      CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_RESOLVE_FAILED,
      expect.any(String),
      expect.any(String),
    );
  });

  it('preserves actual error cause instead of reporting "not found"', async () => {
    const auditSpy = vi.fn();
    const tool = createCrossClawReadTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx({
      fsFactory: (_dir: string) => {
        throw new Error('EACCES: permission denied, open /chestnut/claws/claw1/clawspace/test.txt');
      },
      auditWriter: { write: auditSpy, preview: vi.fn(), message: vi.fn(), summary: vi.fn(), __brand: 'AuditLog' } as unknown as AuditLog,
    });
    const result = await tool.execute({ path: 'test.txt', claw: 'claw1' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('EACCES');
    expect(result.content).not.toContain('not found');
    expect(auditSpy).toHaveBeenCalledWith(
      CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_RESOLVE_FAILED,
      expect.any(String),
      expect.any(String),
    );
  });

  it('readTool.execute 抛 AbortError → 向上传播（不转成 claw not found）', async () => {
    const abortErr = new Error('Execution aborted');
    abortErr.name = 'AbortError';
    vi.spyOn(readTool, 'execute').mockRejectedValue(abortErr);
    const tool = createCrossClawReadTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    await expect(tool.execute({ path: 'test.txt', claw: 'claw1' }, ctx)).rejects.toThrow('Execution aborted');
  });

  it('does not map file not found to claw not found', async () => {
    const failingTopology = {
      ...mockTopology,
      resolve: vi.fn(() => {
        throw new Error('file not found: x.md');
      }),
    };
    const auditSpy = vi.fn();
    const tool = createCrossClawReadTool({ topology: failingTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx({
      auditWriter: { write: auditSpy, preview: vi.fn(), message: vi.fn(), summary: vi.fn(), __brand: 'AuditLog' } as unknown as AuditLog,
    });
    const result = await tool.execute({ path: 'x.md', claw: 'claw1' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).not.toContain('Error: claw "claw1" not found.');
    expect(result.content).toContain('Error accessing claw');
    expect(auditSpy).toHaveBeenCalledWith(
      CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_RESOLVE_FAILED,
      expect.any(String),
      expect.any(String),
    );
  });
});

describe('createCrossClawLsTool', () => {
  const mockTopology = {
    enumerate: () => [makeClawId('motion'), 'claw1'],
    resolve: (clawId: string) => {
      return { kind: 'local', clawDir: `/chestnut/claws/${clawId}` };
    },
    read: vi.fn(),
    readJSON: vi.fn(),
  };

  function makeBaseCtx(overrides?: Partial<ExecContext>): ExecContext {
    return {
      clawId: 'motion',
      clawDir: '/chestnut/motion',
      clawsDir: '/chestnut/claws',
      workspaceDir: '/chestnut/motion/clawspace',
      syncDir: '/chestnut/motion/sync',

      profile: 'full',
      fs: {} as ExecContext['fs'],
      fsFactory: (dir: string) =>
        ({
          read: vi.fn(),
          baseDir: dir,
        } as unknown as ExecContext['fs']),
      stepNumber: 1,
      maxSteps: 100,
      stopRequested: false,
      requestStop: vi.fn(),
      getElapsedMs: vi.fn().mockReturnValue(0),
      incrementStep: vi.fn(),
      readFileState: new Map(),
      ...overrides,
    } as ExecContext;
  }

  it('无 claw → delegate base', async () => {
    const spy = vi.spyOn(lsTool, 'execute').mockResolvedValue({ success: true, content: 'dir' });
    const tool = createCrossClawLsTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ path: '.' }, ctx);
    expect(result).toEqual({ success: true, content: 'dir' });
    expect(spy).toHaveBeenCalledWith({ path: '.' }, ctx);
  });

  it('claw "*" → 拒', async () => {
    const tool = createCrossClawLsTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ path: '.', claw: '*' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('broadcast is not supported by ls');
  });
});

describe('createCrossClawSearchTool broadcast', () => {
  const mockTopology = {
    enumerate: () => [makeClawId('motion'), 'claw1', 'claw2'],
    resolve: (clawId: string) => {
      if (clawId === makeClawId('motion')) return { kind: 'local', clawDir: '/chestnut/motion' };
      return { kind: 'local', clawDir: `/chestnut/claws/${clawId}` };
    },
    read: vi.fn(),
    readJSON: vi.fn(),
  };

  function makeBaseCtx(overrides?: Partial<ExecContext>): ExecContext {
    return {
      clawId: 'motion',
      clawDir: '/chestnut/motion',
      clawsDir: '/chestnut/claws',
      workspaceDir: '/chestnut/motion/clawspace',
      syncDir: '/chestnut/motion/sync',

      profile: 'full',
      fs: {} as ExecContext['fs'],
      fsFactory: (dir: string) =>
        ({
          read: vi.fn(),
          baseDir: dir,
        } as unknown as ExecContext['fs']),
      stepNumber: 1,
      maxSteps: 100,
      stopRequested: false,
      requestStop: vi.fn(),
      getElapsedMs: vi.fn().mockReturnValue(0),
      incrementStep: vi.fn(),
      readFileState: new Map(),
      ...overrides,
    } as ExecContext;
  }

  it('motion 调 claw: "*" → fan-out 所有 claws + 聚合', async () => {
    expect(mockTopology.enumerate()).toEqual([makeClawId('motion'), 'claw1', 'claw2']);
    const spy = vi.spyOn(searchTool, 'execute').mockImplementation(async (_args, passedCtx) => {
      return { success: true, content: `found in ${path.basename(passedCtx.clawDir)}` };
    });
    const tool = createCrossClawSearchTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ text: 'foo', claw: '*' }, ctx);
    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('[claw1]');
    expect(result.content).toContain('[claw2]');
  });

  it('phase 1864 Step H（CT-D11）：无 broadcast capability 的构造 → claw "*" 拒 + emit violation', async () => {
    const auditSpy = vi.fn();
    const tool = createCrossClawSearchTool({ topology: mockTopology, crossTargetAccess });
    const ctx = makeBaseCtx({
      clawId: 'claw1',
      auditWriter: { write: auditSpy, preview: vi.fn(), message: vi.fn(), summary: vi.fn(), __brand: 'AuditLog' } as unknown as AuditLog,
    });
    const result = await tool.execute({ text: 'foo', claw: '*' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Motion-only');
    expect(auditSpy).toHaveBeenCalledWith(
      CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_BROADCAST_MOTION_ONLY_VIOLATION,
      'callerClawId=claw1',
      'reason=not_motion_chain',
    );
  });

  it('phase 1864 Step H（CT-D11）：持 capability 但 ctx 非授权主体 → 运行期第二道拒绝', async () => {
    const auditSpy = vi.fn();
    const tool = createCrossClawSearchTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx({
      clawId: 'claw1',
      auditWriter: { write: auditSpy, preview: vi.fn(), message: vi.fn(), summary: vi.fn(), __brand: 'AuditLog' } as unknown as AuditLog,
    });

    const result = await tool.execute({ text: 'foo', claw: '*' }, ctx);

    expect(result.success).toBe(false);
    expect(auditSpy).toHaveBeenCalledWith(
      CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_BROADCAST_MOTION_ONLY_VIOLATION,
      'callerClawId=claw1',
      'reason=runtime_claw_not_motion',
    );
  });

  it('broadcast 单 claw 失败 → emit broadcast_claw_skipped + 继续其他', async () => {
    const failingTopology = {
      ...mockTopology,
      resolve: vi.fn((clawId: string) => {
        if (clawId === 'claw1') throw new Error('boom');
        return { kind: 'local', clawDir: `/chestnut/claws/${clawId}` };
      }),
    };
    const auditSpy = vi.fn();
    const spy = vi.spyOn(searchTool, 'execute').mockResolvedValue({ success: true, content: 'found' });
    const tool = createCrossClawSearchTool({ topology: failingTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx({
      auditWriter: { write: auditSpy, preview: vi.fn(), message: vi.fn(), summary: vi.fn(), __brand: 'AuditLog' } as unknown as AuditLog,
    });
    const result = await tool.execute({ text: 'foo', claw: '*' }, ctx);
    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1); // only claw2 succeeded
    expect(auditSpy).toHaveBeenCalledWith(
      CLAW_TOPOLOGY_AUDIT_EVENTS.BROADCAST_CLAW_SKIPPED,
      expect.any(String),
      expect.any(String),
    );
  });

  it('无 claw → delegate base tool', async () => {
    const spy = vi.spyOn(searchTool, 'execute').mockResolvedValue({ success: true, content: 'ok' });
    const tool = createCrossClawSearchTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ text: 'foo' }, ctx);
    expect(result).toEqual({ success: true, content: 'ok' });
    expect(spy).toHaveBeenCalledWith({ text: 'foo' }, ctx);
  });

  it('broadcast 所有 claw 失败 → 返回 success:false 并含 all X claws failed', async () => {
    const spy = vi.spyOn(searchTool, 'execute').mockResolvedValue({ success: false, content: 'disk error' });
    const tool = createCrossClawSearchTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ text: 'foo', claw: '*' }, ctx);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.content).toContain('all 2 claws failed');
    expect(result.content).toContain('claw1');
    expect(result.content).toContain('claw2');
  });

  it('broadcast 部分失败 → 结果 content 含失败 claw 列表', async () => {
    const spy = vi.spyOn(searchTool, 'execute').mockImplementation(async (_args, passedCtx) => {
      if (path.basename(passedCtx.clawDir) === 'claw1') {
        return { success: false, content: 'disk error' };
      }
      return { success: true, content: 'found in claw2' };
    });
    const tool = createCrossClawSearchTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ text: 'foo', claw: '*' }, ctx);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.content).toContain('[claw2]');
    expect(result.content).toContain('claws failed: claw1');
  });

  it('signal aborted → throw ExternalAbortError（abort 显式化）', async () => {
    const abortedSignal = new AbortController();
    abortedSignal.abort();
    const spy = vi.spyOn(searchTool, 'execute').mockResolvedValue({ success: true, content: 'found' });
    const tool = createCrossClawSearchTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx({ signal: abortedSignal.signal });
    await expect(tool.execute({ text: 'foo', claw: '*' }, ctx)).rejects.toThrow('Execution aborted');
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('searchTool.execute 在 broadcast 中抛 AbortError → 向上传播（不转成 partial result）', async () => {
    const abortErr = new Error('Execution aborted');
    abortErr.name = 'AbortError';
    vi.spyOn(searchTool, 'execute').mockRejectedValue(abortErr);
    const tool = createCrossClawSearchTool({ topology: mockTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    await expect(tool.execute({ text: 'foo', claw: '*' }, ctx)).rejects.toThrow('Execution aborted');
  });

  it('broadcast 所有 claw resolve 失败 → 返回 success:false 并含 failed（非 No matches）', async () => {
    const failingTopology = {
      ...mockTopology,
      resolve: vi.fn(() => {
        throw new Error('resolve boom');
      }),
    };
    const tool = createCrossClawSearchTool({ topology: failingTopology, broadcast: { grantedTo: makeClawId('motion') }, crossTargetAccess });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ text: 'foo', claw: '*' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('failed');
    expect(result.content).not.toContain('No matches');
  });
});
