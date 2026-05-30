/**
 * phase 1434 — edit-format helpers unit tests
 *
 * Covers: findFirstMatchLine (incl. boundaries), formatEditDiff (mid-file,
 * first-line, last-line, multi-line, delete-only), lineDelta.
 */

import { describe, it, expect } from 'vitest';
import { findFirstMatchLine, formatEditDiff, lineDelta } from '../../../src/foundation/file-tool/edit-format.js';

describe('phase 1434: findFirstMatchLine', () => {
  it('returns 1 for match in first line', () => {
    expect(findFirstMatchLine('hello\nworld\n', 'hello')).toBe(1);
  });

  it('returns correct line for mid-file match', () => {
    expect(findFirstMatchLine('a\nb\nc\nd\n', 'c')).toBe(3);
  });

  it('returns the line of the first occurrence when needle appears multiple times', () => {
    expect(findFirstMatchLine('foo\nbar\nfoo\n', 'foo')).toBe(1);
  });

  it('returns null when needle is not found', () => {
    expect(findFirstMatchLine('abc\n', 'z')).toBeNull();
  });

  it('returns null for empty needle', () => {
    expect(findFirstMatchLine('abc\n', '')).toBeNull();
  });
});

describe('phase 1434: formatEditDiff', () => {
  const file = ['line1', 'line2', 'TARGET', 'line4', 'line5', 'line6', 'line7'].join('\n');

  it('mid-file replace shows ±3 lines context with - / + markers', () => {
    const diff = formatEditDiff(file, 'TARGET', 'NEW');
    expect(diff).toContain('@@ around line 3 @@');
    expect(diff).toContain('  line1');
    expect(diff).toContain('  line2');
    expect(diff).toContain('- TARGET');
    expect(diff).toContain('+ NEW');
    expect(diff).toContain('  line4');
    expect(diff).toContain('  line5');
    expect(diff).toContain('  line6');
  });

  it('first-line replace handles before-context underflow gracefully', () => {
    const f = 'FIRST\nl2\nl3\nl4\nl5\n';
    const diff = formatEditDiff(f, 'FIRST', 'CHANGED');
    expect(diff).toContain('@@ around line 1 @@');
    expect(diff).toContain('- FIRST');
    expect(diff).toContain('+ CHANGED');
    expect(diff).toContain('  l2');
  });

  it('last-line replace handles after-context overflow gracefully', () => {
    const f = 'l1\nl2\nLAST';
    const diff = formatEditDiff(f, 'LAST', 'CHANGED');
    expect(diff).toContain('@@ around line 3 @@');
    expect(diff).toContain('  l1');
    expect(diff).toContain('  l2');
    expect(diff).toContain('- LAST');
    expect(diff).toContain('+ CHANGED');
  });

  it('delete (empty newText) shows only - lines for removed range', () => {
    const f = 'a\nb\nDEL\nc\nd';
    const diff = formatEditDiff(f, 'DEL', '');
    expect(diff).toContain('- DEL');
    expect(diff).not.toContain('+ ');
  });

  it('multi-line replace marks all old and new lines individually', () => {
    const f = ['header', 'old1', 'old2', 'footer'].join('\n');
    const diff = formatEditDiff(f, 'old1\nold2', 'new1\nnew2\nnew3');
    expect(diff).toContain('@@ around line 2 @@');
    expect(diff).toContain('- old1');
    expect(diff).toContain('- old2');
    expect(diff).toContain('+ new1');
    expect(diff).toContain('+ new2');
    expect(diff).toContain('+ new3');
    expect(diff).toContain('  footer');
  });

  it('returns empty string when oldText not found', () => {
    expect(formatEditDiff('abc', 'z', 'y')).toBe('');
  });
});

describe('phase 1434: lineDelta', () => {
  it('single-line to single-line is 0', () => {
    expect(lineDelta('foo', 'bar')).toBe(0);
  });

  it('1 → 3 lines is +2', () => {
    expect(lineDelta('foo', 'a\nb\nc')).toBe(2);
  });

  it('delete is negative', () => {
    expect(lineDelta('a\nb\nc', '')).toBe(-3);
  });

  it('insert (empty old) is positive', () => {
    expect(lineDelta('', 'a\nb')).toBe(2);
  });
});

// phase 1456: error diagnostic helpers
import { findNearMatches, findAllMatchLines } from '../../../src/foundation/file-tool/edit-format.js';

describe('phase 1456: findNearMatches', () => {
  it('exact-prefix: detects line containing first 20 chars of needle', () => {
    const content = 'header\nexport function foo(x: number)\nfooter';
    const matches = findNearMatches(content, 'export function foo(x: number, y: string)');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].line).toBe(2);
    expect(matches[0].score).toBe('exact-prefix');
  });

  it('whitespace-diff: detects line matching after whitespace normalization', () => {
    const content = 'header\n  const  x  =  1\nfooter';
    const matches = findNearMatches(content, 'const x = 1');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].score).toBe('whitespace-diff');
  });

  it('returns empty array when no near matches', () => {
    expect(findNearMatches('completely unrelated content here', 'foo bar baz qux')).toEqual([]);
  });

  it('returns empty array for empty needle', () => {
    expect(findNearMatches('any content', '')).toEqual([]);
  });

  it('respects limit option', () => {
    const content = ['foo line 1', 'foo line 2', 'foo line 3', 'foo line 4', 'foo line 5'].join('\n');
    const matches = findNearMatches(content, 'foo line', { limit: 2 });
    expect(matches.length).toBe(2);
  });

  it('clips long line text to keep diagnostics token-bounded', () => {
    // needle prefix that the long line actually starts with → triggers exact-prefix
    const longLine = 'export function foo(x) ' + 'x'.repeat(500);
    const matches = findNearMatches(longLine, 'export function foo(x: number)');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].text.length).toBeLessThanOrEqual(220); // 200 + "… [truncated]"
    expect(matches[0].text).toContain('[truncated]');
  });
});

describe('phase 1456: findAllMatchLines', () => {
  it('returns 1-based line numbers of all matches up to limit', () => {
    const content = ['foo', 'bar', 'foo', 'baz', 'foo'].join('\n');
    expect(findAllMatchLines(content, 'foo', 5)).toEqual([1, 3, 5]);
  });

  it('respects limit (returns first N only)', () => {
    const content = Array.from({ length: 10 }, () => 'match').join('\n');
    expect(findAllMatchLines(content, 'match', 3)).toEqual([1, 2, 3]);
  });

  it('returns empty array for no matches', () => {
    expect(findAllMatchLines('abc def', 'xyz')).toEqual([]);
  });

  it('returns empty array for empty needle', () => {
    expect(findAllMatchLines('abc', '')).toEqual([]);
  });
});

describe('phase 1456: formatEditDiff last-line edge case', () => {
  it('handles oldText at very last line without crash', () => {
    const content = 'a\nb\nLAST';
    const diff = formatEditDiff(content, 'LAST', 'CHANGED');
    expect(diff).toContain('@@ around line 3 @@');
    expect(diff).toContain('- LAST');
    expect(diff).toContain('+ CHANGED');
  });
});

