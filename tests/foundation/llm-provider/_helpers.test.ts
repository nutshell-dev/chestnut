import { describe, it, expect } from 'vitest';
import { parseRetryAfter } from '../../../src/foundation/llm-provider/_helpers.js';

describe('parseRetryAfter', () => {
  it('returns undefined for null', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseRetryAfter('')).toBeUndefined();
  });

  it('parses integer seconds', () => {
    expect(parseRetryAfter('5')).toBe(5);
  });

  it('parses leading int with trailing chars (parseInt semantics)', () => {
    expect(parseRetryAfter('60s')).toBe(60);
  });

  it('returns NaN for non-numeric (preserves prior behavior, not normalized)', () => {
    expect(parseRetryAfter('abc')).toBeNaN();
  });
});
