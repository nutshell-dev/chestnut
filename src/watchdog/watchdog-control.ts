/** Watchdog stop control. CLI consumes this business outcome, never OS signals. */
import type { FileSystem } from '../foundation/fs/index.js';
import { getChestnutRoot } from '../foundation/claw-identity/index.js';
import { createProcessManagerForCLI } from '../foundation/process-manager/index.js';
import type {
  ProcessTarget,
  ProcessTerminationOutcome,
} from '../foundation/process-exec/index.js';
import { getWatchdogEntryPath } from './watchdog-context.js';
import { inspectWatchdogOwner } from './watchdog-pid.js';
import {
  observeWatchdogProcess,
  terminateWatchdogProcess,
  watchdogProcessTarget,
} from './process-capabilities.js';
import type { WatchdogProcessDeps } from './types.js';

const WATCHDOG_STOP_OPTIONS = {
  graceMs: 5000,
  confirmMs: 500,
  pollIntervalMs: 100,
} as const;

export type WatchdogStopOutcome =
  | {
      kind: 'not_running';
      pid?: number;
      reason: 'no_process' | 'already_gone' | 'identity_changed';
      outcome?: Extract<ProcessTerminationOutcome, { kind: 'gone' }>;
    }
  | {
      kind: 'stopped';
      pid: number;
      outcome: Extract<ProcessTerminationOutcome, { kind: 'gone' }>;
    }
  | {
      kind: 'still_alive';
      pid: number;
      outcome: Extract<ProcessTerminationOutcome, { kind: 'still_alive' }>;
    }
  | {
      kind: 'indeterminate';
      pid?: number;
      stage: 'enumerate' | 'observe' | 'sigterm' | 'sigkill';
      error: unknown;
      outcome?: Extract<ProcessTerminationOutcome, { kind: 'indeterminate' }>;
    };

async function terminateTarget(
  target: ProcessTarget,
  deps?: WatchdogProcessDeps,
): Promise<WatchdogStopOutcome> {
  const outcome = await terminateWatchdogProcess(target, WATCHDOG_STOP_OPTIONS, deps);
  if (outcome.kind === 'gone') {
    if (outcome.via === 'already_gone') {
      return { kind: 'not_running', pid: target.pid, reason: 'already_gone', outcome };
    }
    return { kind: 'stopped', pid: target.pid, outcome };
  }
  if (outcome.kind === 'still_alive') {
    return { kind: 'still_alive', pid: target.pid, outcome };
  }
  return {
    kind: 'indeterminate', pid: target.pid, stage: outcome.stage,
    error: outcome.error, outcome,
  };
}

/** Stop the recorded owner, or discover a legacy owner when its PID file is absent. */
export async function stopWatchdog(
  fsFactory: (baseDir: string) => FileSystem,
  deps?: WatchdogProcessDeps,
): Promise<WatchdogStopOutcome> {
  const recorded = inspectWatchdogOwner(fsFactory, deps);
  if (recorded.kind === 'unknown' || recorded.kind === 'malformed') {
    const error = recorded.kind === 'malformed'
      ? recorded.cause
      : 'cause' in recorded
        ? recorded.cause
        : recorded.observation ?? recorded.decoded;
    return {
      kind: 'indeterminate',
      ...('pid' in recorded ? { pid: recorded.pid } : {}),
      stage: 'observe',
      error,
    };
  }
  if (recorded.kind === 'gone') {
    return {
      kind: 'not_running',
      pid: recorded.pid,
      reason: recorded.reason === 'identity_changed' ? 'identity_changed' : 'already_gone',
    };
  }
  if (recorded.kind === 'alive') {
    return terminateTarget(watchdogProcessTarget(recorded.pid), deps);
  }

  let candidates: number[];
  try {
    const pm = createProcessManagerForCLI({ fsFactory, baseDir: getChestnutRoot() });
    candidates = await pm.findProcessesAsync(getWatchdogEntryPath());
  } catch (error) {
    // silent: the original enumeration error is returned in the typed outcome.
    return { kind: 'indeterminate', stage: 'enumerate', error };
  }

  for (const pid of candidates) {
    const fact = observeWatchdogProcess(pid, deps);
    if (fact.kind === 'indeterminate') {
      return {
        kind: 'indeterminate', pid, stage: 'observe',
        error: fact.observation.error ?? fact.observation,
      };
    }
    if (fact.kind === 'reclaimable') continue;
    return terminateTarget(fact.target, deps);
  }
  return { kind: 'not_running', reason: 'no_process' };
}
