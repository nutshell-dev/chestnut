/**
 * CLI Error — standalone (moved from foundation/errors.ts in phase714)
 */
export class CliError extends Error {
  code: number;

  constructor(message: string, code?: number);
  constructor(message: string, options?: { cause?: unknown; code?: number });
  constructor(
    message: string,
    optionsOrCode?: number | { cause?: unknown; code?: number },
  ) {
    if (typeof optionsOrCode === 'number' || optionsOrCode === undefined) {
      super(message);
      this.code = optionsOrCode ?? 1;
    } else {
      super(message, optionsOrCode);
      this.code = optionsOrCode.code ?? 1;
    }
    this.name = 'CliError';
  }
}

import { ContractValidationError, ContractCapacityError } from '../core/contract/index.js';

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
  if (error instanceof ContractCapacityError) {
    console.error('[contract create] active capacity is full:');
    console.error(`  requested: ${error.requestedContractId}`);
    console.error(`  active:    ${error.activeContractIds.join(', ')}`);
    console.error('');
    console.error('Fix: wait for the active contract to complete, or run chestnut contract cancel --claw <claw-id> --contract <active-id> --reason "<reason>", then retry');
    return 1;
  }
  if (error instanceof CliError) {
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
