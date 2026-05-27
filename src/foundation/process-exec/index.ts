/**
 * @module L1.ProcessExec
 * ProcessExec module (L1)
 *
 * External process execution: the single entry point for all subprocess invocation.
 * Wraps spawn with timeout control, maxBuffer protection, and PATH augmentation.
 *
 * No dependencies.
 */

export { exec } from './exec.js';
export { spawnDetached } from './spawn-detached.js';
export { kill, isAlive } from './process-control.js';
export type { Signal } from './process-control.js';
export { findByPattern } from './find-by-pattern.js';
export type { ExecOptions, ExecResult, SpawnDetachedOptions, ProcessInfo } from './types.js';
export { ProcessExecError } from './types.js';
export { ProcessListUnavailable } from './errors.js';
export {
  PROCESS_EXEC_TIMEOUT_MIN_MS,
  PROCESS_EXEC_TIMEOUT_MAX_MS,
  PROCESS_EXEC_DEFAULT_TIMEOUT_MS,
} from './types.js';
