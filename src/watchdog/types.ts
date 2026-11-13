import type {
  isAlive as defaultIsAlive,
  kill as defaultKill,
  isPidArgvMatching as defaultIsPidArgvMatching,
  ProcessTarget,
  ProcessTargetObservation,
  ProcessTerminationOptions,
  ProcessTerminationOutcome,
} from '../foundation/process-exec/index.js';

export interface WatchdogProcessDeps {
  /** Legacy L1 adapters retained for existing callers and test fixtures. */
  kill?: typeof defaultKill;
  isAlive?: typeof defaultIsAlive;
  isPidArgvMatching?: typeof defaultIsPidArgvMatching;
  /** Typed L1 observation seam; Watchdog maps only OS facts to business facts. */
  observeProcessTarget?: (target: ProcessTarget) => ProcessTargetObservation;
  /** Typed L1 termination seam; TERM/KILL scheduling stays in ProcessExec. */
  terminateProcessTarget?: (
    target: ProcessTarget,
    options?: ProcessTerminationOptions,
  ) => Promise<ProcessTerminationOutcome>;
}
