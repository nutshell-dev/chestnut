import { describe, it, expect } from 'vitest';
import { ContextTrimExhaustedError } from '../../../src/core/context_manager/errors.js';

describe('ContextManager typed errors', () => {
  it('ContextTrimExhaustedError name + instanceof', () => {
    const e = new ContextTrimExhaustedError('msg', { budget: 0 });
    expect(e.name).toBe('ContextTrimExhaustedError');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ContextTrimExhaustedError);
  });

  it('phase 1861 (CM-D6): carries recovery evidence (budget/provider/policy)', () => {
    const policy = { kind: 'reactive', completeFloorTokens: 1_500, completeCeilingTokens: 1_900 } as const;
    const e = new ContextTrimExhaustedError('trim exhausted', {
      budget: 42,
      provider: 'anthropic',
      policy,
    });
    expect(e.evidence.budget).toBe(42);
    expect(e.evidence.provider).toBe('anthropic');
    expect(e.evidence.policy).toEqual(policy);
    expect(e.message).toBe('trim exhausted');
  });

  it('evidence availability is honest — optional fields may be omitted', () => {
    const e = new ContextTrimExhaustedError('trim exhausted', { budget: 0 });
    expect(e.evidence.budget).toBe(0);
    expect(e.evidence.provider).toBeUndefined();
    expect(e.evidence.policy).toBeUndefined();
  });
});
