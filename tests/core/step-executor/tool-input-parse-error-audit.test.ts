import { describe, it, expect } from 'vitest';
import { parseToolInput } from '../../../src/core/step-executor/utils.js';

describe('step-executor — parseToolInput typed result (phase1079)', () => {
  it('returns ok=true with parsed data for valid JSON', () => {
    const result = parseToolInput('{"a":1}', 'tool');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ a: 1 });
    }
  });

  it('returns ok=false with raw and error for invalid JSON', () => {
    const result = parseToolInput('{bad json', 'tool');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.raw).toBe('{bad json');
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
