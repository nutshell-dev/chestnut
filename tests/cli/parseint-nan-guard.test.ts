import { describe, it, expect } from 'vitest';
import { parseIntOption } from '../../src/cli/parse-int-option.js';

describe('parseIntOption', () => {
  it('parses a valid integer string', () => {
    expect(parseIntOption('10', '--limit')).toBe(10);
    expect(parseIntOption('1704067200000', '--since')).toBe(1704067200000);
    expect(parseIntOption('0', '--limit')).toBe(0);
  });

  it('throws CliError for non-numeric string (--limit)', () => {
    expect(() => parseIntOption('abc', '--limit')).toThrow('--limit must be a non-negative integer, got: abc');
  });

  it('throws CliError for non-numeric string (--since)', () => {
    expect(() => parseIntOption('xyz', '--since')).toThrow('--since must be a non-negative integer, got: xyz');
  });

  it('throws CliError for empty string', () => {
    expect(() => parseIntOption('', '--limit')).toThrow('--limit must be a non-negative integer, got: ');
  });

  it('parses integer prefix from mixed alphanumeric string (parseInt behavior)', () => {
    expect(parseIntOption('12abc', '--limit')).toBe(12);
  });
});
