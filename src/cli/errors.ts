/**
 * CLI Error — re-export from foundation (moved in phase1101)
 */
export { CliError } from '../foundation/errors.js';

import { CliError as CliErrorImpl } from '../foundation/errors.js';
import { ContractValidationError } from '../core/contract/index.js';

/**
 * Handle CLI errors uniformly
 * Returns exit code for process.exitCode assignment
 */
export function handleCliError(error: unknown): number {
  if (error instanceof ContractValidationError) {
    console.error('[contract create] yaml validation failed:');
    console.error(`  field:    ${error.field}`);
    console.error(`  kind:     ${error.kind}`);
    console.error(`  message:  ${error.message}`);
    if (error.context) {
      console.error('  context:');
      for (const [k, v] of Object.entries(error.context)) {
        console.error(`    ${k}: ${v}`);
      }
    }
    console.error('');
    console.error('Fix: update the contract yaml according to the message above, then re-run chestnut contract create');
    return 1;
  }
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
