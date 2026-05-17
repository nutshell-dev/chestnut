import { CliError } from './errors.js';

export function parseIntOption(value: string, optionLabel: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new CliError(`${optionLabel} must be a non-negative integer, got: ${value}`);
  }
  return parsed;
}
