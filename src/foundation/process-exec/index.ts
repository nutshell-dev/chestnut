/**
 * @module L1.ProcessExec
 * ProcessExec module (L1)
 *
 * External process execution: the single entry point for all subprocess invocation.
 * Wraps spawn with timeout control, maxBuffer protection, and PATH augmentation.
 *
 * Depends: NodeUtils (formatErr) + node:child_process / node:fs / node:path（外部原生模块）
 */

export { exec, execWithHandle } from './exec.js';
export type {
  ExecHandle,
  ProcessInfo,
  ExecutionIdentity,
  ExecutionTerminationFact,
} from './types.js';
export { terminateExecutionGroup, probeExecutionGroup } from './execution-group.js';
export { probeLegacyProcess, terminateLegacyProcess } from './legacy-process.js';
export { spawnDetached } from './spawn-detached.js';
export { kill, isAlive } from './process-control.js';
export { findByPattern } from './find-by-pattern.js';
export { isPidArgvMatching } from './argv-verify.js';
export { getProcessStartTime, makeProcessStartTime } from './process-starttime.js';
export type { ProcessStartTime } from './process-starttime.js';
export { ProcessExecError, ProcessListUnavailable } from './errors.js';
export {
  PROCESS_EXEC_DEFAULT_TIMEOUT_MS,
  // Needed by command-tool to render the overflow message with the same
  // limit that L1 enforces (phase 1271 F6).
  PROCESS_EXEC_DEFAULT_MAX_BUFFER,
} from './constants.js';
