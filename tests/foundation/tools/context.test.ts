import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { ExecContextImpl, cloneExecContext } from '../../../src/foundation/tools/context.js';
import type { ExecContext } from '../../../src/foundation/tools/types.js';

describe('ExecContextImpl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('ctor uses caller-owned workspaceDir without deriving claw layout', () => {
    const ctx = new ExecContextImpl({
      clawId: 'test',
      clawDir: '/tmp/test-claw',
      workspaceDir: '/tmp/injected-workspace',
      syncDir: '/tmp/test-claw/tasks/sync',
      profile: 'full',
      fs: {} as any,
    });
    expect(ctx.workspaceDir).toBe('/tmp/injected-workspace');
  });

  it('ctor 显式 workspaceDir 覆盖 default', () => {
    const ctx = new ExecContextImpl({
      clawId: 'test',
      clawDir: '/tmp/test-claw',
      workspaceDir: '/tmp/test-claw/tasks/subagents/abc',
      syncDir: '/tmp/test-claw/tasks/sync',
      profile: 'subagent',
      fs: {} as any,
    });
    expect(ctx.workspaceDir).toBe('/tmp/test-claw/tasks/subagents/abc');
  });

  it('cloneExecContext 继承 workspaceDir', () => {
    const parent = new ExecContextImpl({
      clawId: 'p',
      clawDir: '/p',
      workspaceDir: '/p/clawspace',
      syncDir: '/p/tasks/sync',
      profile: 'claw',
      fs: {} as any,
    });
    const cloned = cloneExecContext(parent, { profile: 'subagent' });
    expect(cloned.workspaceDir).toBe('/p/clawspace');
    expect(cloned.profile).toBe('subagent');
  });

  describe('cloneExecContext stopRequested delegation (phase 778 / P0.11)', () => {
    it('clone.stopRequested setter writes back to parent ctx', () => {
      const parent = new ExecContextImpl({
        clawId: 'p',
        clawDir: '/p',
        syncDir: '/p/tasks/sync',
        profile: 'claw',
        fs: {} as any,
      });
      expect(parent.stopRequested).toBe(false);

      const clone = cloneExecContext(parent, { signal: undefined });
      expect(clone.stopRequested).toBe(false);

      // Write to clone.stopRequested
      (clone as { stopRequested: boolean }).stopRequested = true;

      // Verify parent reflects (Object.defineProperty setter delegation)
      expect(parent.stopRequested).toBe(true);
    });

    it('clone.requestStop closure invokes parent ctx.requestStop', () => {
      const parent = new ExecContextImpl({
        clawId: 'p',
        clawDir: '/p',
        syncDir: '/p/tasks/sync',
        profile: 'claw',
        fs: {} as any,
      });
      const requestStopSpy = vi.spyOn(parent, 'requestStop');

      const clone = cloneExecContext(parent, { signal: undefined });
      clone.requestStop();

      expect(requestStopSpy).toHaveBeenCalledTimes(1);
      expect(parent.stopRequested).toBe(true);   // mutation reached parent
    });
  });

  describe('cloneExecContext.requestStop fixture defense (phase 815 / P1.32)', () => {
    it('clone.requestStop is noop when fixture lacks requestStop method', () => {
      // Plain object fixture without requestStop — mirrors `as unknown as ExecContext` test pattern
      const fixture = {
        clawId: 'test',
        clawDir: '/tmp/test',
        stopRequested: false,
        // requestStop intentionally undefined
      } as unknown as ExecContext;

      const clone = cloneExecContext(fixture, { profile: 'subagent' });
      // Must not throw; requestStop becomes a noop
      expect(() => clone.requestStop()).not.toThrow();
      // stopRequested delegation through defineProperty still works (write to clone reflects in fixture)
      (clone as { stopRequested: boolean }).stopRequested = true;
      expect(fixture.stopRequested).toBe(true);
    });

    it('clone.requestStop forwards to parent when fixture defines method', () => {
      const fixture = {
        clawId: 'test',
        clawDir: '/tmp/test',
        stopRequested: false,
        requestStop: vi.fn(),
      } as unknown as ExecContext;

      const clone = cloneExecContext(fixture, { profile: 'subagent' });
      clone.requestStop();
      expect((fixture as unknown as { requestStop: ReturnType<typeof vi.fn> }).requestStop).toHaveBeenCalledTimes(1);
    });
  });
});

/* ========================================================================
 * phase 2092 Step B：cloneExecContext 对可��输出能力（toolOutput）的透传关系
 * ====================================================================== */

describe('phase 2092 B: cloneExecContext.toolOutput 透传', () => {
  type OutputCapability = {
    fs: { writeAtomic: (p: string, c: string) => Promise<{ kind: 'durable' }> };
    syncDir: string;
    workspaceDir: string;
  };

  const outputCapability: OutputCapability = {
    fs: { writeAtomic: async () => ({ kind: 'durable' as const }) },
    syncDir: '/p/tasks/sync',
    workspaceDir: '/p/clawspace',
  };

  it('保留 toolOutput 同一对象，且既有字段与引用不变', () => {
    const auditWriter = { write: () => {} } as unknown as ExecContext['auditWriter'];
    const fsStub = {} as ExecContext['fs'];
    const readFileState = new Map();
    const base = {
      clawId: 'p',
      clawDir: '/p',
      workspaceDir: '/p/clawspace',
      syncDir: '/p/tasks/sync',
      profile: 'claw',
      fs: fsStub,
      auditWriter,
      readFileState,
      stopRequested: false,
      toolOutput: outputCapability,
    } as unknown as ExecContext;

    const cloned = cloneExecContext(base, { profile: 'subagent' });

    // 新字段：同一对象透传（不是拷贝、不是二次 target 化）
    expect((cloned as { toolOutput?: OutputCapability }).toolOutput).toBe(outputCapability);
    // 原字段不变
    expect(cloned.clawId).toBe('p');
    expect(cloned.clawDir).toBe('/p');
    expect(cloned.workspaceDir).toBe('/p/clawspace');
    expect(cloned.syncDir).toBe('/p/tasks/sync');
    expect(cloned.fs).toBe(fsStub);
    expect(cloned.auditWriter).toBe(auditWriter);
    expect(cloned.readFileState).toBe(readFileState);
    expect(cloned.profile).toBe('subagent');
  });

  it('ctx 无 toolOutput 时 clone 也保持 undefined（same-claw 兼容，不虚构能力）', () => {
    const base = {
      clawId: 'p',
      clawDir: '/p',
      workspaceDir: '/p/clawspace',
      syncDir: '/p/tasks/sync',
      profile: 'claw',
      fs: {} as ExecContext['fs'],
      stopRequested: false,
    } as unknown as ExecContext;

    const cloned = cloneExecContext(base, {});
    expect((cloned as { toolOutput?: unknown }).toolOutput).toBeUndefined();
    expect(cloned.workspaceDir).toBe('/p/clawspace');
  });

  it('ExecContextImpl 实例（构造器不携带 toolOutput）clone 后仍无该字段且原字段不变', () => {
    const parent = new ExecContextImpl({
      clawId: 'impl-claw',
      clawDir: '/tmp/impl-claw',
      workspaceDir: '/tmp/impl-claw/clawspace',
      syncDir: '/tmp/impl-claw/tasks/sync',
      profile: 'claw',
      fs: {} as never,
    });
    expect((parent as { toolOutput?: unknown }).toolOutput).toBeUndefined();

    const cloned = cloneExecContext(parent, { profile: 'subagent' });
    expect((cloned as { toolOutput?: unknown }).toolOutput).toBeUndefined();
    expect(cloned.clawId).toBe('impl-claw');
    expect(cloned.clawDir).toBe('/tmp/impl-claw');
    expect(cloned.workspaceDir).toBe('/tmp/impl-claw/clawspace');
    expect(cloned.syncDir).toBe('/tmp/impl-claw/tasks/sync');
  });
});
