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
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new CliError(`${errorPrefix}, got: ${value}`);
  }
  return parsed;
}
