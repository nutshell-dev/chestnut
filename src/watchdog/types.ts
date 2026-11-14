import type {
  captureOwnedProcessRef as defaultCaptureOwnedProcessRef,
  decodeProcessRef as defaultDecodeProcessRef,
  inspectProcessRef as defaultInspectProcessRef,
  kill as defaultKill,
  ProcessTarget,
  ProcessTargetObservation,
  ProcessTerminationOptions,
  ProcessTerminationOutcome,
} from '../foundation/process-exec/index.js';

export interface WatchdogProcessDeps {
  /** Typed capture seam for new persisted owner records. */
  captureOwnedProcessRef?: typeof defaultCaptureOwnedProcessRef;
  /** Typed persisted-identity seams; decoding never performs an OS query. */
  decodeProcessRef?: typeof defaultDecodeProcessRef;
  inspectProcessRef?: typeof defaultInspectProcessRef;
  /** Typed dynamic-target observation seam for enumerated {pid, argvToken}. */
  observeProcessTarget?: (target: ProcessTarget) => ProcessTargetObservation;
  /** Typed L1 termination seam; TERM/KILL scheduling stays in ProcessExec. */
  terminateProcessTarget?: (
    target: ProcessTarget,
    options?: ProcessTerminationOptions,
  ) => Promise<ProcessTerminationOutcome>;
  /** Signal adapter consumed only by ProcessExec's typed termination state machine. */
  kill?: typeof defaultKill;
}
