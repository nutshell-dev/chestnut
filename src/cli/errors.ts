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

import { ContractValidationError } from '../core/contract/index.js';

/**
 * phase 1874 Step J: 纯 exit code 映射（无副作用）——供结算事件在 dispose 前落盘用；
 * handleCliError 的呈现/映射语义与其逐位一致（本函数只抽映射、不改行为）。
 */
export function cliExitCodeFor(error: unknown): number {
  if (error instanceof CliError) return error.code;
  return 1;
}

/** phase 1874 Step J: 失败分类（结算事件 error_class 列）。 */
export function cliErrorClassFor(error: unknown): string {
  if (error instanceof ContractValidationError) return 'ContractValidationError';
  if (error instanceof CliError) return 'CliError';
  if (error instanceof Error) return 'Error';
  return 'unknown';
}

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
