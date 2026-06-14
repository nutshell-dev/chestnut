import { describe, it, expect } from 'vitest';
import { parseIntOption } from '../../src/cli/parse-int-option.js';

describe('parseIntOption (Layer A validation)', () => {
  it('parses a valid integer string', () => {
    expect(parseIntOption('10', '--limit must be a non-negative integer')).toBe(10);
    expect(parseIntOption('1704067200000', '--since must be a Unix timestamp in milliseconds')).toBe(1704067200000);
    expect(parseIntOption('0', '--limit must be a non-negative integer')).toBe(0);
  });

  it('throws CliError for non-numeric --limit', () => {
    expect(() => parseIntOption('abc', '--limit must be a non-negative integer'))
      .toThrow('--limit must be a non-negative integer, got: abc');
  });

  it('throws CliError for non-numeric --since with "Unix timestamp in milliseconds" semantic context', () => {
    expect(() => parseIntOption('xyz', '--since must be a Unix timestamp in milliseconds'))
      .toThrow('--since must be a Unix timestamp in milliseconds, got: xyz');
  });

  it('throws CliError for empty string', () => {
    expect(() => parseIntOption('', '--limit must be a non-negative integer'))
      .toThrow('--limit must be a non-negative integer, got: ');
  });

  // phase 366 L2 (review-2026-06-13): strict 守、不再 silent 截断 trailing 非数字
  it('phase 366 L2: rejects mixed alphanumeric string (no silent truncation)', () => {
    expect(() => parseIntOption('12abc', '--limit must be a non-negative integer'))
      .toThrow('--limit must be a non-negative integer, got: 12abc');
  });

  it('phase 366 L2: rejects float syntax', () => {
    expect(() => parseIntOption('12.5', '--limit must be a non-negative integer'))
      .toThrow('--limit must be a non-negative integer, got: 12.5');
  });

  it('phase 366 L2: accepts negative integer', () => {
    expect(parseIntOption('-5', '--limit must be a non-negative integer')).toBe(-5);
  });
});
