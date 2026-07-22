import { describe, expect, it } from 'vitest';
import {
  InvalidUnicodeStringError,
  assertWellFormedUnicode,
  truncateUtf8Prefix,
} from '../../../src/foundation/node-utils/utf8.js';

describe('assertWellFormedUnicode', () => {
  it('accepts empty string', () => {
    expect(() => assertWellFormedUnicode('')).not.toThrow();
  });

  it('accepts ASCII', () => {
    expect(() => assertWellFormedUnicode('hello')).not.toThrow();
  });

  it('accepts BMP CJK', () => {
    expect(() => assertWellFormedUnicode('中文')).not.toThrow();
  });

  it('accepts emoji surrogate pair', () => {
    expect(() => assertWellFormedUnicode('😀')).not.toThrow();
  });

  it('rejects lone high surrogate', () => {
    expect(() => assertWellFormedUnicode('a\uD83Db')).toThrow(InvalidUnicodeStringError);
  });

  it('rejects lone low surrogate', () => {
    expect(() => assertWellFormedUnicode('a\uDC00b')).toThrow(InvalidUnicodeStringError);
  });

  it('reports code unit index and value', () => {
    try {
      assertWellFormedUnicode('abc\uD83D');
      expect.fail('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidUnicodeStringError);
      expect((error as InvalidUnicodeStringError).codeUnitIndex).toBe(3);
      expect((error as InvalidUnicodeStringError).codeUnit).toBe(0xd83d);
    }
  });
});

describe('truncateUtf8Prefix', () => {
  it('returns empty for empty string or zero budget', () => {
    expect(truncateUtf8Prefix('', 0)).toBe('');
    expect(truncateUtf8Prefix('', 100)).toBe('');
    expect(truncateUtf8Prefix('hello', 0)).toBe('');
  });

  it('accepts exact ASCII budget', () => {
    expect(truncateUtf8Prefix('hello', 5)).toBe('hello');
  });

  it('truncates ASCII under budget', () => {
    expect(truncateUtf8Prefix('hello world', 5)).toBe('hello');
  });

  it('keeps whole CJK code point when it fits', () => {
    // '中' = 3 UTF-8 bytes
    expect(truncateUtf8Prefix('中', 3)).toBe('中');
  });

  it('drops CJK code point when budget is too small', () => {
    expect(truncateUtf8Prefix('中', 2)).toBe('');
  });

  it('keeps whole emoji when it fits', () => {
    // 😀 = U+1F600 = 4 UTF-8 bytes
    expect(truncateUtf8Prefix('😀', 4)).toBe('😀');
  });

  it('drops emoji when budget is smaller than 4 bytes', () => {
    expect(truncateUtf8Prefix('😀', 3)).toBe('');
  });

  it('keeps prefix ASCII and drops emoji crossing 100-byte boundary', () => {
    const content = `${'a'.repeat(99)}😀tail`;
    const result = truncateUtf8Prefix(content, 100);
    expect(result).toBe('a'.repeat(99));
    expect(Buffer.byteLength(result, 'utf8')).toBe(99);
  });

  it('keeps emoji when budget covers it', () => {
    const content = `${'a'.repeat(96)}😀tail`;
    const result = truncateUtf8Prefix(content, 100);
    expect(result).toBe(`${'a'.repeat(96)}😀`);
    expect(Buffer.byteLength(result, 'utf8')).toBe(100);
  });

  it('rejects lone high surrogate', () => {
    expect(() => truncateUtf8Prefix('a\uD83D', 100)).toThrow(InvalidUnicodeStringError);
  });

  it('rejects lone low surrogate', () => {
    expect(() => truncateUtf8Prefix('a\uDC00', 100)).toThrow(InvalidUnicodeStringError);
  });

  it('rejects negative maxBytes', () => {
    expect(() => truncateUtf8Prefix('hello', -1)).toThrow(RangeError);
  });

  it('rejects non-integer maxBytes', () => {
    expect(() => truncateUtf8Prefix('hello', 1.5)).toThrow(RangeError);
  });

  it('result is always original prefix', () => {
    const result = truncateUtf8Prefix('hello world', 7);
    expect('hello world'.startsWith(result)).toBe(true);
  });

  it('result byte length never exceeds budget', () => {
    const input = 'abc 中文 😀🎉 end';
    for (let budget = 0; budget <= 30; budget++) {
      const result = truncateUtf8Prefix(input, budget);
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(budget);
    }
  });
});
