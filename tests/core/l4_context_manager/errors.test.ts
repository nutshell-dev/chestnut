import { describe, it, expect } from 'vitest';
import { ContextTrimExhaustedError } from '../../../src/core/l4_context_manager/errors.js';

describe('ContextManager typed errors', () => {
  it('ContextTrimExhaustedError name + instanceof', () => {
    const e = new ContextTrimExhaustedError('msg');
    expect(e.name).toBe('ContextTrimExhaustedError');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ContextTrimExhaustedError);
  });
});
