import { describe, it, expect } from 'vitest';
import { cloneExecContext } from '../../../src/foundation/tools/context.js';
import type { ExecContext } from '../../../src/foundation/tools/context.js';

describe('cloneExecContext stopRequested getter fallback (phase 929)', () => {
  it('plain object mock without stopRequested field → cloned getter returns false (not undefined)', () => {
    // Arrange: plain object mock 缺 stopRequested + requestStop (mimic phase 815 P1.32 fixture defense)
    const fixture = {
      clawId: 'test',
      // 故意省略 stopRequested + requestStop fields
    } as unknown as ExecContext;

    // Act
    const clone = cloneExecContext(fixture);

    // Assert: getter returns false (not undefined)
    expect(clone.stopRequested).toBe(false);
    expect(typeof clone.stopRequested).toBe('boolean');
  });

  it('真 ExecContextImpl ctx stopRequested=false → cloned getter returns false (unchanged behavior)', () => {
    const realCtx = {
      clawId: 'test',
      stopRequested: false,
      requestStop: () => {},
    } as unknown as ExecContext;
    const clone = cloneExecContext(realCtx);
    expect(clone.stopRequested).toBe(false);
  });

  it('真 ctx stopRequested=true → cloned getter returns true (unchanged behavior)', () => {
    const realCtx = {
      clawId: 'test',
      stopRequested: true,
      requestStop: () => {},
    } as unknown as ExecContext;
    const clone = cloneExecContext(realCtx);
    expect(clone.stopRequested).toBe(true);
  });

  it('setter through clone mutates parent ctx (phase 778 invariant unchanged)', () => {
    const realCtx = {
      clawId: 'test',
      stopRequested: false,
      requestStop: () => {},
    } as unknown as ExecContext & { stopRequested: boolean };
    const clone = cloneExecContext(realCtx);
    (clone as ExecContext & { stopRequested: boolean }).stopRequested = true;
    expect(realCtx.stopRequested).toBe(true);
  });
});
