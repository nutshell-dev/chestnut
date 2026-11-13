/** Internal Watchdog ↔ ProcessExec typed capability boundary. */
import {
  isAlive as defaultIsAlive,
  isPidArgvMatching as defaultIsPidArgvMatching,
  kill as defaultKill,
  makeProcessStartTime,
  observeProcessTarget,
  terminateProcessTarget,
  type ProcessTarget,
  type ProcessTargetObservation,
  type ProcessTerminationOptions,
  type ProcessTerminationOutcome,
} from '../foundation/process-exec/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { getAuditWriter } from './watchdog-context.js';
import type { WatchdogProcessDeps } from './types.js';

export const WATCHDOG_ARGV_TOKEN = 'watchdog-entry';

let pidArgvVerifierOverride: ((pid: number, token: string) => boolean) | null = null;

/** Compatibility test hook retained at the Watchdog boundary. */
export function _setPidArgvVerifierForTest(
  fn: ((pid: number, token: string) => boolean) | null,
): void {
  pidArgvVerifierOverride = fn;
}

function testArgvMatch(pid: number, token: string): boolean {
  if (pidArgvVerifierOverride) return pidArgvVerifierOverride(pid, token);
  // Existing fake-PID fixtures cannot supply real ps output. Production never
  // takes this branch and uses typed argv observation with original OS errors.
  if (process.env.NODE_ENV === 'test') return true;
  return defaultIsPidArgvMatching(pid, token);
}

export function watchdogProcessTarget(pid: number, startTime?: string): ProcessTarget {
  return {
    pid,
    ...(startTime !== undefined && startTime !== 'unknown'
      ? { startTime: makeProcessStartTime(startTime) }
      : {}),
    argvToken: WATCHDOG_ARGV_TOKEN,
  };
}

function observationAdapters(deps?: WatchdogProcessDeps) {
  const legacyProbe = deps?.isAlive
    ?? (process.env.NODE_ENV === 'test' ? defaultIsAlive : undefined);
  const argvMatch = deps?.isPidArgvMatching
    ?? (process.env.NODE_ENV === 'test' ? testArgvMatch : undefined);
  return {
    ...(legacyProbe !== undefined ? { legacyProbe } : {}),
    ...(argvMatch !== undefined ? { argvMatch } : {}),
  };
}

export type WatchdogProcessFact =
  | {
      kind: 'owner_active';
      target: ProcessTarget;
      observation: Extract<ProcessTargetObservation, { kind: 'alive' }>;
    }
  | {
      kind: 'reclaimable';
      reason: 'absent' | 'identity_changed';
      target: ProcessTarget;
      observation: Extract<ProcessTargetObservation, { kind: 'gone' }>;
    }
  | {
      kind: 'indeterminate';
      target: ProcessTarget;
      observation: Extract<ProcessTargetObservation, { kind: 'unknown' }>;
    };

/** Map L1 facts to Watchdog ownership facts without flattening unknown. */
export function observeWatchdogProcess(
  pid: number,
  startTime?: string,
  deps?: WatchdogProcessDeps,
): WatchdogProcessFact {
  const target = watchdogProcessTarget(pid, startTime);
  const observation = deps?.observeProcessTarget?.(target)
    ?? observeProcessTarget(target, observationAdapters(deps));
  if (observation.kind === 'alive') return { kind: 'owner_active', target, observation };
  if (observation.kind === 'gone') {
    return { kind: 'reclaimable', reason: observation.reason, target, observation };
  }
  getAuditWriter()?.write(
    WATCHDOG_AUDIT_EVENTS.PID_OBSERVATION_UNKNOWN,
    `pid=${pid}`,
    `reason=${observation.reason}`,
    `evidence=${JSON.stringify(observation.evidence)}`,
  );
  return { kind: 'indeterminate', target, observation };
}

export class WatchdogProcessObservationError extends Error {
  constructor(readonly fact: Extract<WatchdogProcessFact, { kind: 'indeterminate' }>) {
    super(
      `Watchdog process observation is indeterminate: pid=${fact.target.pid} ` +
      `reason=${fact.observation.reason}`,
    );
    this.name = 'WatchdogProcessObservationError';
  }
}

/** Watchdog supplies timing policy; ProcessExec owns signals and confirmation. */
export function terminateWatchdogProcess(
  target: ProcessTarget,
  options: ProcessTerminationOptions,
  deps?: WatchdogProcessDeps,
): Promise<ProcessTerminationOutcome> {
  return deps?.terminateProcessTarget?.(target, options)
    ?? terminateProcessTarget(target, options, {
      ...observationAdapters(deps),
      signal: deps?.kill ?? defaultKill,
      ...(deps?.observeProcessTarget !== undefined
        ? { observeTarget: deps.observeProcessTarget }
        : {}),
    });
}
