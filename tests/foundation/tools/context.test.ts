import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { ExecContextImpl, cloneExecContext } from '../../../src/foundation/tools/context.js';

describe('ExecContextImpl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('ctor 默认 workspaceDir = clawDir/clawspace', () => {
    const ctx = new ExecContextImpl({
      clawId: 'test',
      clawDir: '/tmp/test-claw',
      syncDir: '/tmp/test-claw/tasks/sync',
      profile: 'full',
      fs: {} as any,
    });
    expect(ctx.workspaceDir).toBe('/tmp/test-claw/clawspace');
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
