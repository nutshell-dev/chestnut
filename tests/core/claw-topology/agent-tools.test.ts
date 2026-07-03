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
    const tool = createCrossClawReadTool({ topology: mockTopology, allowed: true });
    expect(tool.schema.properties).toHaveProperty('claw');
    expect(tool.name).toBe(readTool.name);
  });

  it('args.claw === undefined → delegate base tool（同 claw fallback）', async () => {
    const spy = vi.spyOn(readTool, 'execute').mockResolvedValue({ success: true, content: 'hello' });
    const tool = createCrossClawReadTool({ topology: mockTopology, allowed: true });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ path: 'test.txt' }, ctx);
    expect(result).toEqual({ success: true, content: 'hello' });
    expect(spy).toHaveBeenCalledWith({ path: 'test.txt' }, ctx);
  });

  it('args.claw === "<id>" → 改 ctx 调 base、readFileState 不污染 caller', async () => {
    const callerReadFileState = new Map();
    const spy = vi.spyOn(readTool, 'execute').mockImplementation(async (_args, passedCtx) => {
      expect(passedCtx.clawDir).toBe('/chestnut/claws/claw1');
      expect(passedCtx.workspaceDir).toBe('/chestnut/claws/claw1/clawspace');
      expect(passedCtx.readFileState).not.toBe(callerReadFileState);
      expect(passedCtx.fs).toBeDefined();
      return { success: true, content: 'cross-claw content' };
    });
    const tool = createCrossClawReadTool({ topology: mockTopology, allowed: true });
    const ctx = makeBaseCtx({ readFileState: callerReadFileState });
    const result = await tool.execute({ path: 'test.txt', claw: 'claw1' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toBe('cross-claw content');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'test.txt' }),
      expect.anything(),
    );
  });

  it('args.claw === "*" → 拒（read 不支持 broadcast）', async () => {
    const tool = createCrossClawReadTool({ topology: mockTopology, allowed: true });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ path: 'test.txt', claw: '*' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('broadcast is not supported by read');
  });

  it('args.claw 无效 → 返回错误', async () => {
    const tool = createCrossClawReadTool({ topology: mockTopology, allowed: true });
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
    const tool = createCrossClawReadTool({ topology: failingTopology, allowed: true });
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
    const tool = createCrossClawLsTool({ topology: mockTopology, allowed: true });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ path: '.' }, ctx);
    expect(result).toEqual({ success: true, content: 'dir' });
    expect(spy).toHaveBeenCalledWith({ path: '.' }, ctx);
  });

  it('claw "*" → 拒', async () => {
    const tool = createCrossClawLsTool({ topology: mockTopology, allowed: true });
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
    const tool = createCrossClawSearchTool({ topology: mockTopology, allowed: true });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ text: 'foo', claw: '*' }, ctx);
    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('[claw1]');
    expect(result.content).toContain('[claw2]');
  });

  it('非 motion 调 claw: "*" → 拒 + emit cross_claw_broadcast_motion_only_violation', async () => {
    const auditSpy = vi.fn();
    const tool = createCrossClawSearchTool({ topology: mockTopology, allowed: false });
    const ctx = makeBaseCtx({
      clawId: 'claw1',
      auditWriter: { write: auditSpy, preview: vi.fn(), message: vi.fn(), summary: vi.fn(), __brand: 'AuditLog' } as unknown as AuditLog,
    });
    const result = await tool.execute({ text: 'foo', claw: '*' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Motion-only');
    expect(auditSpy).toHaveBeenCalledWith(
      CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_BROADCAST_MOTION_ONLY_VIOLATION,
      expect.any(String),
      expect.any(String),
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
    const tool = createCrossClawSearchTool({ topology: failingTopology, allowed: true });
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
    const tool = createCrossClawSearchTool({ topology: mockTopology, allowed: true });
    const ctx = makeBaseCtx();
    const result = await tool.execute({ text: 'foo' }, ctx);
    expect(result).toEqual({ success: true, content: 'ok' });
    expect(spy).toHaveBeenCalledWith({ text: 'foo' }, ctx);
  });

  it('signal aborted → 提前终止 fan-out', async () => {
    const abortedSignal = new AbortController();
    abortedSignal.abort();
    const spy = vi.spyOn(searchTool, 'execute').mockResolvedValue({ success: true, content: 'found' });
    const tool = createCrossClawSearchTool({ topology: mockTopology, allowed: true });
    const ctx = makeBaseCtx({ signal: abortedSignal.signal });
    const result = await tool.execute({ text: 'foo', claw: '*' }, ctx);
    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(0);
  });
});
