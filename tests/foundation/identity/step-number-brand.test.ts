import { describe, it, expect } from 'vitest';
import { makeStepNumber } from '../../../src/foundation/identity/step-number.js';

describe('StepNumber brand (phase 216 Step A)', () => {
  it('makeStepNumber(0) returns brand value', () => {
    expect(makeStepNumber(0)).toBe(0);
  });

  it('makeStepNumber(42) returns brand value', () => {
    expect(makeStepNumber(42)).toBe(42);
  });

  it('throws on negative', () => {
    expect(() => makeStepNumber(-1)).toThrow('expected non-negative integer');
  });

  it('throws on NaN', () => {
    expect(() => makeStepNumber(NaN)).toThrow('expected non-negative integer');
  });

  it('throws on Infinity', () => {
    expect(() => makeStepNumber(Infinity)).toThrow('expected non-negative integer');
  });

  it('throws on non-integer', () => {
    expect(() => makeStepNumber(1.5)).toThrow('expected non-negative integer');
  });

  it('throws on non-number', () => {
    expect(() => makeStepNumber('1' as unknown as number)).toThrow('expected non-negative integer');
  });

  it('brand transparent in audit emit format (M#7 跨进程契约)', () => {
    const sn = makeStepNumber(42);
    expect(`step=${sn}`).toBe('step=42');
  });
});
