import { describe, it, expect } from 'vitest';
import { AUDIT_PREVIEW_LEN, AUDIT_MESSAGE_MAX_CHARS } from '../../../src/foundation/audit/index.js';

describe('phase 982: AUDIT_PREVIEW_LEN const', () => {
  it('exports value = 100', () => {
    expect(AUDIT_PREVIEW_LEN).toBe(100);
  });

  it('semantically distinct from AUDIT_MESSAGE_MAX_CHARS (100 vs 200)', () => {
    expect(AUDIT_PREVIEW_LEN).not.toBe(AUDIT_MESSAGE_MAX_CHARS);
    expect(AUDIT_PREVIEW_LEN).toBeLessThan(AUDIT_MESSAGE_MAX_CHARS);
  });

  it('representative caller use produces 100-char truncate invariant', () => {
    const input = 'x'.repeat(500);
    const previewed = input.slice(0, AUDIT_PREVIEW_LEN);
    expect(previewed.length).toBe(100);
    expect(previewed).toBe('x'.repeat(100));
  });
});
