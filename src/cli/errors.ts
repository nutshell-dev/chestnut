/**
 * CLI Error — re-export from foundation (moved in phase1101)
 */
export { CliError } from '../foundation/errors.js';

import { CliError as CliErrorImpl } from '../foundation/errors.js';

/**
 * Handle CLI errors uniformly
 * Returns exit code for process.exitCode assignment
 */
export function handleCliError(error: unknown): number {
  if (error instanceof CliErrorImpl) {
    console.error(error.message);
    return error.code;
  }
  if (error instanceof Error) {
    console.error('Error:', error.message);
    return 1;
  }
  console.error('Error:', String(error));
  return 1;
}
