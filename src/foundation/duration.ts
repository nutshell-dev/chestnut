/**
 * @module L2a.Duration
 * Generic duration parser shared by CLI commands.
 *
 * Format: `<number><unit>` where unit ∈ { s, m, h }
 *   5m  → 5 * 60 * 1000 ms
 *   30m → 30 * 60 * 1000 ms
 *   1h  → 60 * 60 * 1000 ms
 *   24h → 24 * 60 * 60 * 1000 ms (max for watch subscription)
 *   90s → 90 * 1000 ms
 *
 * 0 / negative / unknown unit → throw `DurationParseError`.
 */

export class DurationParseError extends Error {
  constructor(public readonly input: string, reason: string) {
    super(`invalid duration "${input}": ${reason}`);
    this.name = 'DurationParseError';
  }
}

const DURATION_RE = /^(\d+)([smh])$/;
const UNIT_TO_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/** Parse duration string to milliseconds. Throws on invalid input. */
export function parseDurationMs(input: string): number {
  const m = input.trim().match(DURATION_RE);
  if (!m) {
    throw new DurationParseError(input, 'expected format <N><s|m|h>, e.g. "5m" / "1h" / "30s"');
  }
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) {
    throw new DurationParseError(input, 'value must be positive integer');
  }
  const factor = UNIT_TO_MS[unit];
  if (factor === undefined) {
    throw new DurationParseError(input, `unknown unit "${unit}"`);
  }
  return n * factor;
}
