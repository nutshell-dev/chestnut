import { CliError } from './errors.js';

/**
 * Parse CLI option as integer, throw CliError with full error message on NaN.
 *
 * Layer A validation helper. Caller passes full error prefix (excluding "got: <value>" suffix)
 * to preserve domain-specific semantic context (e.g. "Unix timestamp in milliseconds" vs generic "non-negative integer").
 *
 * @param value Raw CLI option string value
 * @param errorPrefix Full error message prefix (e.g. "--since must be a Unix timestamp in milliseconds")
 * @throws CliError when value is non-numeric
 * @returns Parsed integer
 */
export function parseIntOption(value: string, errorPrefix: string): number {
  // phase 366 L2 (review-2026-06-13): strict 整数验。旧 `parseInt(str, 10)` 静默
  // 截断 trailing 非数字 ('100x' → 100, '12.5' → 12)，CLI typo 被静默接受。
  // 用 regex 守纯整数（可选前导 -）再 parseInt。
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new CliError(`${errorPrefix}, got: ${value}`);
  }
  const parsed = parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new CliError(`${errorPrefix}, got: ${value}`);
  }
  return parsed;
}
