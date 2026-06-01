/**
 * phase 5: duration parser unit tests.
 */

import { describe, it, expect } from 'vitest';
import { parseDurationMs, DurationParseError } from '../../src/foundation/duration.js';

describe('parseDurationMs', () => {
  it('parses seconds', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseDurationMs('5m')).toBe(5 * 60_000);
    expect(parseDurationMs('30m')).toBe(30 * 60_000);
  });

  it('parses hours', () => {
    expect(parseDurationMs('1h')).toBe(60 * 60_000);
    expect(parseDurationMs('24h')).toBe(24 * 60 * 60_000);
  });

  it('trims whitespace', () => {
    expect(parseDurationMs(' 5m ')).toBe(5 * 60_000);
  });

  it('rejects zero', () => {
    expect(() => parseDurationMs('0s')).toThrow(DurationParseError);
  });

  it('rejects negative (regex hits)', () => {
    expect(() => parseDurationMs('-5m')).toThrow(DurationParseError);
  });

  it('rejects unknown unit', () => {
    expect(() => parseDurationMs('5d')).toThrow(DurationParseError);
  });

  it('rejects empty', () => {
    expect(() => parseDurationMs('')).toThrow(DurationParseError);
  });

  it('rejects bare number', () => {
    expect(() => parseDurationMs('5')).toThrow(DurationParseError);
  });
});
