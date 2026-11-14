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
export { resolveHostCommand } from './host-command.js';
export type { ResolvedHostCommand } from './host-command.js';
export { resolveHostScript } from './host-script.js';
export type { ResolvedHostScript } from './host-script.js';
export type {
  ExecHandle,
  ProcessInfo,
  ExecutionIdentity,
  ExecutionTerminationFact,
  ExecutionTerminationOutcome,
  ExecutionTerminationTrigger,
} from './types.js';
export { terminateExecutionGroup, probeExecutionGroup } from './execution-group.js';
export {
  captureExecutionTarget,
  decodeExecutionTarget,
  observeExecutionTarget,
  terminateExecutionTarget,
} from './execution-target.js';
export type {
  ExecutionGroupTarget,
  ExecutionTarget,
  ExecutionTargetCapture,
  ExecutionTargetDecode,
  ExecutionTargetObservation,
  LegacyExecutionTarget,
} from './execution-target.js';
export { spawnDetached } from './spawn-detached.js';
export type { SpawnDetachedOptions, SpawnDetachedOutcome, SpawnDetachedFailure, ProcessTarget } from './types.js';
export { kill } from './process-control.js';
export {
  findByPatternSyncForCli,
  findByLiteralPatternSyncForCli,
  findByPatternAsync,
  findByLiteralPatternAsync,
} from './find-by-pattern.js';
export type { FindByPatternOptions } from './find-by-pattern.js';
export { observePidArgv } from './argv-verify.js';
export type { ProcessArgvObservation } from './argv-verify.js';
export { makeProcessStartTime } from './process-starttime.js';
export type { ProcessStartTime } from './process-starttime.js';
export {
  captureCurrentProcessRef,
  captureOwnedProcessRef,
  decodeProcessRef,
  inspectProcessRef,
} from './process-reference.js';
export type {
  ProcessRef,
  ProcessRefCapture,
  ProcessRefDecode,
  ProcessRefObservation,
  ProcessUnavailableReason,
} from './process-reference.js';
export { terminateProcessRef } from './process-ref-target.js';
export type { ProcessRefTerminationAdapters } from './process-ref-target.js';
export {
  captureCurrentProcessIdentity,
  captureProcessTarget,
  observeProcessTarget,
  observeProcessTargetWithLegacyProbeForTest,
  processCommandContainsToken,
  terminateMatchingProcesses,
  terminateProcessTarget,
} from './process-target.js';
export type {
  ProcessMatchCleanupOptions,
  ProcessMatchCleanupOutcome,
  ProcessTargetCapture,
  ProcessTargetObservation,
  ProcessTerminationAdapters,
  ProcessTerminationOptions,
  ProcessTerminationOutcome,
} from './process-target.js';
export type { ProcessEvidence, ProcessEvidenceValue } from './process-evidence.js';
export {
  ProcessExecError,
  ProcessListUnavailable,
  UnsupportedHostScriptError,
} from './errors.js';
export type {
  ProcessListErrorEvidence,
  ProcessListFailureClassification,
  ProcessListOperation,
} from './errors.js';
export {
  PROCESS_EXEC_DEFAULT_TIMEOUT_MS,
  // Needed by command-tool to render the overflow message with the same
  // limit that L1 enforces (phase 1271 F6).
  PROCESS_EXEC_DEFAULT_MAX_BUFFER,
} from './constants.js';

export { subscribeHostExit, HostExitSubscriptionError } from './host-exit.js';
export type { HostExitEvent } from './host-exit.js';
export { createSpawnEnvironment } from './spawn-environment.js';
export type { SpawnEnvironmentOutcome } from './spawn-environment.js';
