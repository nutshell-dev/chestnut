/**
 * @module L1.ProcessExec
 * ProcessExec module (L1)
 *
 * External process execution: the single entry point for all subprocess invocation.
 * Wraps spawn with timeout control, maxBuffer protection, and PATH augmentation.
 *
 * No dependencies.
 */

export { exec, execWithHandle } from './exec.js';
export type { ExecHandle } from './types.js';
export { spawnDetached } from './spawn-detached.js';
export { kill, isAlive } from './process-control.js';
export type { Signal } from './process-control.js';
export { findByPattern } from './find-by-pattern.js';
export { isPidArgvMatching, readPidArgv } from './argv-verify.js';
export { getProcessStartTime, makeProcessStartTime } from './process-starttime.js';
export type { ProcessStartTime } from './process-starttime.js';
export { ProcessExecError, ProcessListUnavailable } from './errors.js';
export {
  PROCESS_EXEC_TIMEOUT_MIN_MS,
  PROCESS_EXEC_DEFAULT_TIMEOUT_MS,
} from './constants.js';
