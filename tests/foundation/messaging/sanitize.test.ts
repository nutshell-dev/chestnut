import { describe, it, expect } from 'vitest';
import {
  sanitizeMessageIdentifier,
  assertSafeKey,
} from '../../../src/foundation/messaging/sanitize.js';

describe('sanitizeMessageIdentifier', () => {
  it('rejects path traversal in message identifier', () => {
    expect(() => sanitizeMessageIdentifier('../../etc', 'from')).toThrow();
    expect(() => sanitizeMessageIdentifier('a/b', 'to')).toThrow();
    expect(() => sanitizeMessageIdentifier('', 'from')).toThrow();
  });

  it('accepts valid identifiers', () => {
    expect(sanitizeMessageIdentifier('motion', 'from')).toBe('motion');
    expect(sanitizeMessageIdentifier('claw_test-01', 'to')).toBe('claw_test-01');
  });
});

describe('assertSafeKey', () => {
  it('rejects frontmatter keys with newlines', () => {
    expect(() => assertSafeKey('to\npriority: high')).toThrow();
  });

  it('rejects frontmatter keys with colons', () => {
    expect(() => assertSafeKey('key:value')).toThrow();
  });

  it('rejects frontmatter keys with document separator', () => {
    expect(() => assertSafeKey('---')).toThrow();
  });

  it('accepts safe keys', () => {
    expect(() => assertSafeKey('contract_id')).not.toThrow();
    expect(() => assertSafeKey('subtask-id')).not.toThrow();
  });
});
