import { describe, it, expect } from 'vitest';
import { makeExecContext } from './exec-context.js';

describe('makeExecContext', () => {
  it('returns sound default ExecContext', () => {
    const ctx = makeExecContext();
    expect(ctx.clawId).toBe('test-claw');
    expect(typeof ctx.getElapsedMs).toBe('function');
    expect(typeof ctx.requestStop).toBe('function');
    expect(typeof ctx.getElapsedMs).toBe('function');
    expect(ctx.stopRequested).toBe(false);
  });

  it('overrides shallow-merge', () => {
    const ctx = makeExecContext({ clawId: 'foo', callerType: 'shadow' });
    expect(ctx.clawId).toBe('foo');
    expect(ctx.callerType).toBe('shadow');
    // defaults untouched
    expect(ctx.stopRequested).toBe(false);
  });

  it('signal override threads through', () => {
    const ac = new AbortController();
    const ctx = makeExecContext({ signal: ac.signal });
    expect(ctx.signal).toBe(ac.signal);
  });

  describe('noopFs frozen invariant (audit-2026-05-16 §4 / phase 905)', () => {
    it('freeze 后 mutate throw TypeError (反向 1: defense-in-depth)', () => {
      const ctx = makeExecContext();
      expect(() => {
        (ctx.fs as Record<string, unknown>).readFile = () => Promise.resolve('');
      }).toThrow(TypeError);
    });

    it('smoke: 既有 26 caller pattern read fs property 0 throw (反向 2: backward compat)', () => {
      const ctx = makeExecContext();
      expect(ctx.fs).toBeDefined();
      expect(typeof ctx.fs).toBe('object');
    });
  });
});
