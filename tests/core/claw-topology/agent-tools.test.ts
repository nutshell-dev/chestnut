import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import {
  createCrossClawReadTool,
  createCrossClawLsTool,
  createCrossClawSearchTool,
} from '../../../src/core/claw-topology/agent-tools.js';
import { CLAW_TOPOLOGY_AUDIT_EVENTS } from '../../../src/core/claw-topology/audit-events.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';
import { readTool, lsTool, searchTool } from '../../../src/foundation/file-tool/index.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import type { ExecContext } from '../../../src/foundation/tools/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
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

  // phase 1897: vitest 4 的 spyOn 对已 mock 属性复用同一 mock（v3 会重建并重置状态）
  // → 无 restore 时 execute 计数跨测试累积。显式 restore，下一测试 spyOn 拿新 mock。
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

/* ========================================================================
 * phase 2092 Step B：跨 claw 输出能力与取回基准（真实 NodeFileSystem + 真实工具 + 真实权限 checker）
 *
 * 语义：读目标不变、权限不变；溢出产物写 caller.syncDir、提示路径相对 caller.workspaceDir，
 * caller 用不带 claw 参数的普通 read 即可取回；target 侧不得新增产物或 read-state。
 * ====================================================================== */

describe('phase 2092 B: cross-claw overflow output ownership', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  interface ClawLayout {
    readonly clawDir: string;
    readonly workspaceDir: string;
    readonly syncDir: string;
  }

  function makeClawRoot(rel: string, workspaceSubdir?: string): ClawLayout {
    const clawDir = path.join(tempDir, rel);
    const workspaceDir = workspaceSubdir
      ? path.join(clawDir, workspaceSubdir)
      : path.join(clawDir, 'clawspace');
    for (const dir of [workspaceDir, path.join(clawDir, 'tasks/sync')]) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
    return { clawDir, workspaceDir, syncDir: path.join(clawDir, 'tasks/sync') };
  }

  function makeRealCtx(
    layout: ClawLayout,
    clawId: string,
    extra?: Record<string, unknown>,
  ): ExecContext {
    return new ExecContextImpl({
      clawId,
      clawDir: layout.clawDir,
      workspaceDir: layout.workspaceDir,
      syncDir: layout.syncDir,
      profile: 'full',
      fs: new NodeFileSystem({ baseDir: layout.clawDir }),
      fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }),
      permissionChecker: createClawPermissionChecker({
        audit: makeMockAudit(),
        clawDir: layout.clawDir,
        strict: true,
        fs: new NodeFileSystem({ baseDir: layout.clawDir }),
      }),
      auditWriter: makeMockAudit(),
      ...extra,
    } as never);
  }

  const realAccess: CrossTargetAccess = {
    grantedBy: 'test-cross-target',
    createChecker: ({ clawDir }) => createClawPermissionChecker({
      audit: makeMockAudit(),
      clawDir,
      strict: true,
      fs: new NodeFileSystem({ baseDir: clawDir }),
    }),
  };

  function makeTopology(dirs: Record<string, string>) {
    return {
      enumerate: () => Object.keys(dirs).map((id) => makeClawId(id)),
      resolve: (id: string) => ({ kind: 'local' as const, clawDir: dirs[id]! }),
    } as unknown as ClawTopology;
  }

  async function listDirSafe(dir: string): Promise<string[]> {
    try {
      return (await fs.readdir(dir)).sort();
    } catch {
      return [];
    }
  }

  async function fileCountDeep(dir: string): Promise<number> {
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const entry of await listDirSafe(d)) {
        const full = path.join(d, entry);
        const st = await fs.stat(full);
        if (st.isDirectory()) await walk(full);
        else out.push(full);
      }
    };
    try { await walk(dir); } catch { /* dir missing = 0 */ }
    return out.length;
  }

  /** read 工具提示：read: { "path": "<rel>", "offset": 1, ... } */
  function parseReadHint(content: string): string | undefined {
    const m = /read: \{ "path": "(.+?)", "offset": 1, "limit": 200 \}/.exec(content);
    return m?.[1];
  }

  /** search footer：Full results saved at <rel>. Use `read` to view: read({ "path": "<rel>", ... }) */
  function parseSearchHint(content: string): string | undefined {
    const m = /Full results saved at (.+?)\. Use `read` to view: read\(\{ "path": "(.+?)", "offset": 1, "limit": 200 \}\)/.exec(content);
    return m?.[2];
  }

  const BIG_LINE = (i: number): string => `row-${String(i).padStart(5, '0')} ${'x'.repeat(90)}`;
  const BIG_ROWS = 2500;                         // ≈ 250KB > 100KB read 字节上限
  const SEARCH_HITS = 30;                        // > 20 条预览上限，必然落盘

  async function seedTarget(workspaceDir: string, marker: string): Promise<void> {
    const big = Array.from({ length: BIG_ROWS }, (_, i) => BIG_LINE(i)).join('\n');
    await fs.writeFile(path.join(workspaceDir, 'big.txt'), `${big}\n${marker}\n`);
    await fs.writeFile(
      path.join(workspaceDir, 'hits.txt'),
      Array.from({ length: SEARCH_HITS }, (_, i) => `needle-${marker}-${String(i).padStart(3, '0')}`).join('\n'),
    );
  }

  it('B1 跨目标 read + search overflow：产物归 caller，target 零新增产物/read-state，源文件不变', async () => {
    const caller = makeClawRoot('a/caller');
    const target = makeClawRoot('b/deep/target');
    await seedTarget(target.workspaceDir, 'TARGET-MARKER-B1');
    const bigPath = path.join(target.workspaceDir, 'big.txt');
    const sourceBefore = await fs.readFile(bigPath, 'utf-8');

    const callerCtx = makeRealCtx(caller, 'caller-claw');
    const readFileStateBefore = new Map(callerCtx.readFileState);
    const tools = {
      read: createCrossClawReadTool({ topology: makeTopology({ 'target-claw': target.clawDir }), crossTargetAccess: realAccess }),
      search: createCrossClawSearchTool({ topology: makeTopology({ 'target-claw': target.clawDir }), crossTargetAccess: realAccess }),
    };

    const readResult = await tools.read.execute({ path: 'big.txt', limit: BIG_ROWS + 10, claw: 'target-claw' }, callerCtx);
    const searchResult = await tools.search.execute({ text: 'needle', claw: 'target-claw' }, callerCtx);

    // caller 侧取得产物
    const callerReadArtifacts = await listDirSafe(path.join(caller.syncDir, 'read'));
    const callerSearchArtifacts = await listDirSafe(path.join(caller.syncDir, 'search'));
    expect(callerReadArtifacts).toHaveLength(1);
    expect(callerSearchArtifacts).toHaveLength(1);
    expect(readResult.success).toBe(true);
    expect(readResult.content).not.toContain('overflow persist failed');
    expect(parseReadHint(readResult.content)).toBeDefined();
    expect(searchResult.success).toBe(true);
    expect(parseSearchHint(searchResult.content)).toBeDefined();

    // artifact 正文完整
    const readArtifact = await fs.readFile(path.join(caller.syncDir, 'read', callerReadArtifacts[0]!), 'utf-8');
    expect(readArtifact).toContain('TARGET-MARKER-B1');
    expect(readArtifact).toContain(BIG_LINE(0));
    const searchArtifact = await fs.readFile(path.join(caller.syncDir, 'search', callerSearchArtifacts[0]!), 'utf-8');
    expect(searchArtifact.match(/needle-TARGET-MARKER-B1-\d{3}/g)).toHaveLength(SEARCH_HITS);

    // target 侧零新增产物（sync 目录、read-state.json 均无）
    expect(await fileCountDeep(path.join(target.clawDir, 'tasks'))).toBe(0);
    expect(await listDirSafe(path.join(target.clawDir))).not.toContain('read-state.json');

    // 源文件未变；caller read-state 未被 target 路径污染
    expect(await fs.readFile(bigPath, 'utf-8')).toBe(sourceBefore);
    expect(callerCtx.readFileState).toEqual(readFileStateBefore);
  });

  it('B2 提示路径用 caller 普通 read（不带 claw 参数）可取回完整 artifact', async () => {
    const caller = makeClawRoot('caller-side/nest/caller');
    const target = makeClawRoot('unrelated/elsewhere/target');
    await seedTarget(target.workspaceDir, 'TARGET-MARKER-B2');

    const topology = makeTopology({ 'target-claw': target.clawDir });
    const read = createCrossClawReadTool({ topology, crossTargetAccess: realAccess });
    const search = createCrossClawSearchTool({ topology, crossTargetAccess: realAccess });
    const callerCtx = makeRealCtx(caller, 'caller-claw');

    const readResult = await read.execute({ path: 'big.txt', limit: BIG_ROWS + 10, claw: 'target-claw' }, callerCtx);
    const searchResult = await search.execute({ text: 'needle', claw: 'target-claw' }, callerCtx);

    const readRel = parseReadHint(readResult.content);
    const searchRel = parseSearchHint(searchResult.content);
    expect(readRel).toBeDefined();
    expect(searchRel).toBeDefined();

    // caller 普通 context + 不带 claw 参数的 read 取回
    const readBackRead = await readTool.execute({ path: readRel!, offset: 1, limit: 400 }, callerCtx);
    expect(readBackRead.success).toBe(true);
    expect(readBackRead.content).toContain('source: read_overflow');
    expect(readBackRead.content).toContain('row-00000');
    // artifact 正文完整（marker 在文件尾部，超出 400 行窗口 → 直接读文件核验）
    const readArtifactAbs = path.resolve(caller.workspaceDir, readRel!);
    expect(await fs.readFile(readArtifactAbs, 'utf-8')).toContain('TARGET-MARKER-B2');

    const readBackSearch = await readTool.execute({ path: searchRel!, offset: 1, limit: 200 }, callerCtx);
    expect(readBackSearch.success).toBe(true);
    expect(readBackSearch.content).toContain('source: search_overflow');
    expect(readBackSearch.content).toContain('needle-TARGET-MARKER-B2-000');
  });

  it('B3 caller.workspaceDir 为子代理子目录：提示路径按 caller 基准生成且可取回', async () => {
    const caller = makeClawRoot('caller-side', path.join('tasks', 'subagents', 'task-abc'));
    const target = makeClawRoot('target-side');
    await seedTarget(target.workspaceDir, 'TARGET-MARKER-B3');

    const topology = makeTopology({ 'target-claw': target.clawDir });
    const read = createCrossClawReadTool({ topology, crossTargetAccess: realAccess });
    const callerCtx = makeRealCtx(caller, 'caller-claw');

    const result = await read.execute({ path: 'big.txt', limit: BIG_ROWS + 10, claw: 'target-claw' }, callerCtx);
    const rel = parseReadHint(result.content);
    expect(rel).toBeDefined();
    // 基准是 caller.workspaceDir（子代理目录），而非 clawDir、也不是 target
    expect(path.resolve(caller.workspaceDir, rel!)).toBe(
      path.resolve(path.join(caller.syncDir, 'read'), path.basename(rel!)),
    );
    expect(rel!.startsWith('..')).toBe(true);

    const readBack = await readTool.execute({ path: rel!, offset: 1, limit: 400 }, callerCtx);
    expect(readBack.success).toBe(true);
    expect(readBack.content).toContain('source: read_overflow');
    expect(await fs.readFile(path.resolve(caller.workspaceDir, rel!), 'utf-8')).toContain('TARGET-MARKER-B3');
  });

  it('B4 同 claw 省略 claw 参数：旧输出/持久化/权限不变，ctx.toolOutput 可缺省', async () => {
    const caller = makeClawRoot('same-claw');
    await seedTarget(caller.workspaceDir, 'SAME-CLAW-MARKER');
    const topology = makeTopology({ 'target-claw': caller.clawDir });
    const read = createCrossClawReadTool({ topology, crossTargetAccess: realAccess });
    const search = createCrossClawSearchTool({ topology, crossTargetAccess: realAccess });
    const callerCtx = makeRealCtx(caller, 'caller-claw');
    expect((callerCtx as { toolOutput?: unknown }).toolOutput).toBeUndefined();

    const readResult = await read.execute({ path: 'big.txt', limit: BIG_ROWS + 10 }, callerCtx);
    const searchResult = await search.execute({ text: 'needle' }, callerCtx);

    expect(readResult.success).toBe(true);
    expect(searchResult.success).toBe(true);
    expect(await listDirSafe(path.join(caller.syncDir, 'read'))).toHaveLength(1);
    expect(await listDirSafe(path.join(caller.syncDir, 'search'))).toHaveLength(1);
    const rel = parseReadHint(readResult.content)!;
    expect(rel.startsWith('..')).toBe(true);
    const readBack = await readTool.execute({ path: rel, offset: 1, limit: 400 }, callerCtx);
    expect(readBack.content).toContain('source: read_overflow');
    expect(await fs.readFile(path.resolve(caller.workspaceDir, rel), 'utf-8')).toContain('SAME-CLAW-MARKER');
  });

  it('B5 broadcast：两个目标各触发 overflow → 两份 artifact 均归 caller 且正文对应各自目标', async () => {
    const caller = makeClawRoot('caller-b');
    const targetA = makeClawRoot('target-a');
    const targetB = makeClawRoot('target-b');
    await seedTarget(targetA.workspaceDir, 'MARKER-A');
    await seedTarget(targetB.workspaceDir, 'MARKER-B');

    const topology = makeTopology({
      motion: makeClawRoot('motion-root').clawDir,
      'claw-a': targetA.clawDir,
      'claw-b': targetB.clawDir,
    });
    const search = createCrossClawSearchTool({
      topology,
      broadcast: { grantedTo: makeClawId('motion') },
      crossTargetAccess: realAccess,
    });
    const motionCtx = makeRealCtx(caller, 'motion');

    const result = await search.execute({ text: 'needle', claw: '*' }, motionCtx);
    expect(result.success).toBe(true);

    const artifacts = await listDirSafe(path.join(caller.syncDir, 'search'));
    expect(artifacts).toHaveLength(2);
    const bodies = await Promise.all(
      artifacts.map((f) => fs.readFile(path.join(caller.syncDir, 'search', f), 'utf-8')),
    );
    const joined = bodies.join('\n---\n');
    expect(joined).toContain('needle-MARKER-A-000');
    expect(joined).toContain('needle-MARKER-B-000');
    // 两份 artifact 各自只含对应目标
    const aBody = bodies.find((b) => b.includes('needle-MARKER-A-000'))!;
    const bBody = bodies.find((b) => b.includes('needle-MARKER-B-000'))!;
    expect(aBody).not.toContain('needle-MARKER-B-000');
    expect(bBody).not.toContain('needle-MARKER-A-000');

    // 两个 target 都不留下任何产物
    expect(await fileCountDeep(path.join(targetA.clawDir, 'tasks'))).toBe(0);
    expect(await fileCountDeep(path.join(targetB.clawDir, 'tasks'))).toBe(0);
  });

  it('B6 target 侧拒绝依旧拒绝（EACCES / symlink 逃逸），不被 output 写能力放宽且不产生 artifact', async () => {
    const caller = makeClawRoot('caller-c');
    const target = makeClawRoot('target-c');
    const outside = path.join(tempDir, 'outside-secret.txt');
    await fs.writeFile(outside, 'outside secret');
    // (a) OS 级权限拒绝：文件 chmod 0000
    const deniedFile = path.join(target.workspaceDir, 'denied.txt');
    await fs.writeFile(deniedFile, 'should not be readable');
    await fs.chmod(deniedFile, 0o000);
    // (b) 路径守卫拒绝：clawspace 内 symlink 指向 claw 外部
    await fs.symlink(outside, path.join(target.workspaceDir, 'escape.txt'));

    const topology = makeTopology({ 'target-claw': target.clawDir });
    const read = createCrossClawReadTool({ topology, crossTargetAccess: realAccess });
    const callerCtx = makeRealCtx(caller, 'caller-claw');

    try {
      // 既有语义：readTool.execute 内部抛出的拒绝（async rejection）不会被包装器吞成 success，
      // 也不存在「靠 output 写能力把拒绝变成成功」的路径——本轮不改该失败语义。
      // (a) OS 级拒绝：read 既有行为返回 success=false（不改该语义）
      const eacces = await read.execute({ path: 'denied.txt', claw: 'target-claw' }, callerCtx);
      expect(eacces.success).toBe(false);
      expect(eacces.content).toMatch(/EACCES|permission denied/i);

      // (b) 权限面/路径守卫拒绝：既有行为是 execute 内抛出（async rejection）→ 不得变成功

      const escapeErr = await read
        .execute({ path: 'escape.txt', claw: 'target-claw' }, callerCtx)
        .then(() => null, (e: unknown) => e as Error);
      expect(escapeErr).not.toBeNull();
      expect(String(escapeErr?.message)).toMatch(/not within claw root|Symlink traversal|resolves outside base root/i);
      expect(String(escapeErr?.message)).not.toContain('outside secret');

      // 拒绝不得因 output 写能力变成落盘
      expect(await fileCountDeep(caller.syncDir)).toBe(0);
      expect(await fileCountDeep(path.join(target.clawDir, 'tasks'))).toBe(0);
      expect(await listDirSafe(target.clawDir)).not.toContain('read-state.json');
    } finally {
      await fs.chmod(deniedFile, 0o600).catch(() => { /* silent: cleanup */ });
    }
  });

  it('B6b output.writeAtomic 失败：沿既有各工具错误出口与 audit 传递，不谎报 saved', async () => {
    const caller = makeClawRoot('caller-d');
    const target = makeClawRoot('target-d');
    await seedTarget(target.workspaceDir, 'MARKER-D');

    const failingFs = new Proxy(new NodeFileSystem({ baseDir: caller.clawDir }), {
      get(t, prop) {
        if (prop === 'writeAtomic') {
          return async () => { throw new Error('output disk full injection'); };
        }
        const v = Reflect.get(t, prop, t);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as FileSystem;

    const callerAudit = makeMockAudit();
    const callerCtx = makeRealCtx(caller, 'caller-claw', { fs: failingFs, auditWriter: callerAudit });
    const topology = makeTopology({ 'target-claw': target.clawDir });
    const read = createCrossClawReadTool({ topology, crossTargetAccess: realAccess });
    const search = createCrossClawSearchTool({ topology, crossTargetAccess: realAccess });

    const callerReadStateBefore = new Map(callerCtx.readFileState);

    const searchResult = await search.execute({ text: 'needle', claw: 'target-claw' }, callerCtx);
    expect(searchResult.success).toBe(false);
    expect(searchResult.content).toContain('overflow persist failed');
    expect(searchResult.content).not.toContain('Full results saved at');

    // phase 2098 Step B：跨 claw read 的保存失败同样如实失败，且保留部分内容/失败说明、
    // 不给取回提示（无 artifact）、caller 侧零产物、caller 读取状态不被 target 污染。
    const readResult = await read.execute({ path: 'big.txt', limit: BIG_ROWS + 10, claw: 'target-claw' }, callerCtx);
    expect(readResult.success).toBe(false);
    expect(readResult.content).toContain(BIG_LINE(0));
    expect(readResult.content).toContain('overflow persist failed');
    expect(parseReadHint(readResult.content)).toBeUndefined();
    expect(await fileCountDeep(caller.syncDir)).toBe(0);
    expect(callerCtx.readFileState).toEqual(callerReadStateBefore);

    const auditTypes = (callerAudit.write as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((c) => c[0]);
    expect(auditTypes).toContain('search_overflow_persist_failed');
    expect(auditTypes).toContain('read_overflow_persist_failed');
    // 失败也不写 target
    expect(await fileCountDeep(path.join(target.clawDir, 'tasks'))).toBe(0);
  });

  it('B7 已有 toolOutput 时保留同一能力对象、不被二次 target 化（产物落原 syncDir）', async () => {
    const caller = makeClawRoot('caller-e');
    const target = makeClawRoot('target-e');
    await seedTarget(target.workspaceDir, 'MARKER-E');

    const outerSync = path.join(caller.clawDir, 'outer-sync');
    fsSync.mkdirSync(outerSync, { recursive: true });
    const outerOutput = {
      fs: new NodeFileSystem({ baseDir: caller.clawDir }),
      syncDir: outerSync,
      workspaceDir: caller.workspaceDir,
    };
    const callerCtx = makeRealCtx(caller, 'caller-claw');
    // 计划的「不改 ExecContextImplOptions/构造器」：toolOutput 由包装器后续注入
    Object.assign(callerCtx, { toolOutput: outerOutput });

    const read = createCrossClawReadTool({
      topology: makeTopology({ 'target-claw': target.clawDir }),
      crossTargetAccess: realAccess,
    });
    const result = await read.execute({ path: 'big.txt', limit: BIG_ROWS + 10, claw: 'target-claw' }, callerCtx);

    // 落在既有 toolOutput.syncDir（不是 caller.syncDir、也不是 target）
    expect(await listDirSafe(path.join(outerSync, 'read'))).toHaveLength(1);
    expect(await listDirSafe(path.join(caller.syncDir, 'read'))).toHaveLength(0);
    expect(await fileCountDeep(path.join(target.clawDir, 'tasks'))).toBe(0);

    // 同一对象不被替换（能力对象身份守恒）
    expect((callerCtx as unknown as { toolOutput: unknown }).toolOutput).toBe(outerOutput);
    const rel = parseReadHint(result.content);
    expect(rel).toBeDefined();
    const readBack = await readTool.execute({ path: rel!, offset: 1, limit: 400 }, callerCtx);
    expect(readBack.content).toContain('source: read_overflow');
    expect(await fs.readFile(path.resolve(caller.workspaceDir, rel!), 'utf-8')).toContain('MARKER-E');
  });

  it('phase 2099：target stat 失败留审计，caller 同相对路径状态不变且 target 不落 read-state', async () => {
    const caller = makeClawRoot('caller-2099');
    const target = makeClawRoot('target-2099');
    await fs.writeFile(path.join(caller.workspaceDir, 'note.txt'), 'CALLER-CONTENT');
    await fs.writeFile(path.join(target.workspaceDir, 'note.txt'), 'TARGET-CONTENT');
    const callerAudit = makeMockAudit();
    const targetError = Object.assign(new Error('synthetic target stat EIO'), { code: 'EIO' });
    const callerCtx = makeRealCtx(caller, 'caller-claw', {
      auditWriter: callerAudit,
      fsFactory: (baseDir: string) => {
        const nodeFs = new NodeFileSystem({ baseDir });
        if (baseDir !== target.clawDir) return nodeFs;
        return new Proxy(nodeFs, {
          get(t, prop) {
            if (prop === 'stat') {
              return async (p: string) => {
                if (p === 'clawspace/note.txt') throw targetError;
                return t.stat(p);
              };
            }
            const value = Reflect.get(t, prop, t);
            return typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(t)
              : value;
          },
        }) as FileSystem;
      },
    });
    expect((await readTool.execute({ path: 'note.txt' }, callerCtx)).success).toBe(true);
    const callerStateBefore = new Map(callerCtx.readFileState);
    const read = createCrossClawReadTool({
      topology: makeTopology({ 'target-claw': target.clawDir }),
      crossTargetAccess: realAccess,
    });

    const result = await read.execute({ path: 'note.txt', claw: 'target-claw' }, callerCtx);

    expect(result).toEqual({ success: true, content: 'TARGET-CONTENT' });
    expect(callerCtx.readFileState).toEqual(callerStateBefore);
    expect(await listDirSafe(target.clawDir)).not.toContain('read-state.json');
    const calls = (callerAudit.write as unknown as {
      mock: { calls: Array<[string, ...(string | number)[]]> };
    }).mock.calls;
    const event = calls.find((entry) => entry[0] === 'read_file_stat_failed');
    expect(event).toBeDefined();
    expect(event).toContain(`claw_dir=${target.clawDir}`);
    expect(event).toContain('path=clawspace/note.txt');
    expect(event).toContain('invalidated=false');
    expect(event?.join(' ')).toContain('EIO');
  });

  describe('phase 2095 B: committed result remains caller-visible', () => {
    it.each([
      ['committed_platform_limited', 'EINVAL'],
      ['committed_durability_unknown', 'EIO'],
    ] as const)('%s：caller 单份产物可取回，提示与 caller 审计一致', async (kind, code) => {
      const caller = makeClawRoot('caller-2095');
      const target = makeClawRoot('target-2095');
      await seedTarget(target.workspaceDir, `MARKER-2095-${kind}`);
      const sourcePath = path.join(target.workspaceDir, 'big.txt');
      const sourceBefore = await fs.readFile(sourcePath, 'utf8');
      const error = Object.assign(new Error(`synthetic ${code} after rename`), { code });
      let overflowWrites = 0;
      const outputFs = new Proxy(new NodeFileSystem({ baseDir: caller.clawDir }), {
        get(t, prop) {
          if (prop === 'writeAtomic') {
            return async (p: string, content: string) => {
              overflowWrites++;
              await t.writeAtomic(p, content);
              return { kind, error };
            };
          }
          const value = Reflect.get(t, prop, t);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(t)
            : value;
        },
      }) as FileSystem;
      const callerAudit = makeMockAudit();
      const callerCtx = makeRealCtx(caller, 'caller-claw', {
        fs: outputFs,
        auditWriter: callerAudit,
      });
      const callerReadStateBefore = new Map(callerCtx.readFileState);
      const read = createCrossClawReadTool({
        topology: makeTopology({ 'target-claw': target.clawDir }),
        crossTargetAccess: realAccess,
      });

      const result = await read.execute(
        { path: 'big.txt', limit: BIG_ROWS + 10, claw: 'target-claw' },
        callerCtx,
      );

      expect(result.success).toBe(true);
      expect(result.content).toContain(
        `[artifact committed but durability unconfirmed: ${kind}]`,
      );
      expect(result.content).not.toContain('overflow persist failed');
      const rel = parseReadHint(result.content)!;
      expect(rel).toBeDefined();
      expect(overflowWrites).toBe(1);
      expect(await listDirSafe(path.join(caller.syncDir, 'read'))).toEqual([path.basename(rel)]);
      expect(await fileCountDeep(path.join(target.clawDir, 'tasks'))).toBe(0);
      expect(await fs.readFile(sourcePath, 'utf8')).toBe(sourceBefore);
      expect(callerCtx.readFileState).toEqual(callerReadStateBefore);
      expect(await listDirSafe(target.clawDir)).not.toContain('read-state.json');

      const artifact = await fs.readFile(path.resolve(caller.workspaceDir, rel), 'utf8');
      expect(artifact.endsWith(sourceBefore)).toBe(true);
      const readBack = await readTool.execute({ path: rel, offset: 1, limit: 6 }, callerCtx);
      expect(readBack.success).toBe(true);
      expect(readBack.content).toContain('source: read_overflow');
      expect(readBack.content).toContain('row-00000');

      const calls = (callerAudit.write as unknown as {
        mock: { calls: Array<[string, ...(string | number)[]]> };
      }).mock.calls;
      const event = calls.find((entry) => entry[0] === 'read_overflow_persist_failed');
      expect(event).toBeDefined();
      expect(event).toContain('stage=durability');
      expect(event).toContain(`commit=${kind}`);
      expect(event).toContain(`path=${rel}`);
      expect(event?.join(' ')).toContain(code);
    });
  });
});
