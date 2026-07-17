/**
 * phase 1109 Step B: literal-replace primitive tests
 */

import { describe, it, expect } from 'vitest';
import { literalReplace } from '../../../src/foundation/file-tool/literal-replace.js';

describe('literalReplace', () => {
  it('rejects empty oldText as not-found', () => {
    const result = literalReplace('hello world', '', 'x', 'unique');
    expect(result).toEqual({ ok: false, reason: 'not-found', matches: 0 });
  });

  it('rejects zero matches as not-found', () => {
    const result = literalReplace('hello world', 'xyz', 'abc', 'unique');
    expect(result).toEqual({ ok: false, reason: 'not-found', matches: 0 });
  });

  it('rejects multiple matches in unique mode', () => {
    const result = literalReplace('foo bar foo', 'foo', 'qux', 'unique');
    expect(result).toEqual({ ok: false, reason: 'multiple-matches', matches: 2 });
  });

  it('replaces a unique match', () => {
    const result = literalReplace('hello world', 'hello', 'hi', 'unique');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('hi world');
    expect(result.matches).toBe(1);
    expect(result.replaced).toBe(1);
    expect(result.firstIndex).toBe(0);
  });

  it('replaces all matches in all mode', () => {
    const result = literalReplace('foo bar foo baz foo', 'foo', 'qux', 'all');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('qux bar qux baz qux');
    expect(result.matches).toBe(3);
    expect(result.replaced).toBe(3);
    expect(result.firstIndex).toBe(0);
  });

  it('treats $& as literal text (not regex special)', () => {
    const result = literalReplace('pattern = $&', '$&', 'REPLACED', 'unique');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('pattern = REPLACED');
  });

  it('treats $` as literal text', () => {
    const result = literalReplace('use `$` prefix', '$`', 'BACKTICK', 'unique');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('use `BACKTICK prefix');
  });

  it('treats $\' as literal text (the data-scout incident)', () => {
    const result = literalReplace(
      "regex = r'\\d+$'",
      "r'\\d+$'",
      "r'\\w+'",
      'unique',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe("regex = r'\\w+'");
  });

  it('treats $$ as literal text', () => {
    const result = literalReplace('price = $$5', '$$', 'USD', 'unique');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('price = USD5');
  });

  it('treats \\1 as literal text', () => {
    const result = literalReplace('capture \\1 here', '\\1', 'GROUP', 'unique');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('capture GROUP here');
  });

  it('treats \\g<1> as literal text', () => {
    const result = literalReplace('named \\g<1> here', '\\g<1>', 'GROUP', 'unique');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('named GROUP here');
  });

  it('preserves emoji and CJK characters', () => {
    const result = literalReplace('hello 🌍 世界', 'hello', 'hi', 'unique');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('hi 🌍 世界');
  });

  it('preserves CRLF line endings', () => {
    const result = literalReplace('line1\r\nline2\r\n', 'line2', 'LINE2', 'unique');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('line1\r\nLINE2\r\n');
  });

  it('preserves files without trailing newline', () => {
    const result = literalReplace('no newline at end', 'end', 'finish', 'unique');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('no newline at finish');
  });

  it('uses non-overlapping matches', () => {
    const result = literalReplace('aaaa', 'aa', 'b', 'all');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('bb');
    expect(result.matches).toBe(2);
  });

  it('empty newText deletes the matched range', () => {
    const result = literalReplace('hello world', 'hello ', '', 'unique');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('world');
  });

  it('firstIndex points to the first match position', () => {
    const result = literalReplace('abc def abc', 'def', 'DEF', 'unique');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.firstIndex).toBe(4);
  });
});
