/** Internal Watchdog ↔ ProcessExec typed capability boundary. */
import {
  kill as defaultKill,
  decodeProcessRef,
  inspectProcessRef,
  observeProcessTarget,
  terminateProcessTarget,
  type ProcessRefDecode,
  type ProcessRefObservation,
  type ProcessTarget,
  type ProcessTargetObservation,
  type ProcessTerminationOptions,
  type ProcessTerminationOutcome,
} from '../foundation/process-exec/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { getAuditWriter } from './watchdog-context.js';
import type { WatchdogProcessDeps } from './types.js';
import type { WatchdogOwnerRecord } from './watchdog-ownership.js';

export const WATCHDOG_ARGV_TOKEN = 'watchdog-entry';

let pidArgvVerifierOverride: ((pid: number, token: string) => boolean) | null = null;

/** Explicit test-only argv seam; production never reads this override. */
export function _setPidArgvVerifierForTest(
  fn: ((pid: number, token: string) => boolean) | null,
): void {
  pidArgvVerifierOverride = fn;
}

function refOverride(pid: number): ProcessRefObservation | undefined {
  if (pidArgvVerifierOverride === null) return undefined;
  const evidence = { version: 1 as const, atMs: Date.now(), facts: [] };
  return pidArgvVerifierOverride(pid, WATCHDOG_ARGV_TOKEN)
    ? { kind: 'alive', evidence }
    : { kind: 'gone', reason: 'identity_changed', evidence };
}

function targetOverride(pid: number): ProcessTargetObservation | undefined {
  return refOverride(pid);
}

/** Dynamic discovery carries only the identity ProcessExec can verify itself. */
export function watchdogProcessTarget(pid: number): ProcessTarget {
  return { pid, argvToken: WATCHDOG_ARGV_TOKEN };
}

export type WatchdogProcessRefInspection =
  | {
      kind: 'alive';
      decoded: Extract<ProcessRefDecode, { kind: 'decoded' }>;
      observation: Extract<ProcessRefObservation, { kind: 'alive' }>;
    }
  | {
      kind: 'gone';
      reason: 'absent' | 'identity_changed';
      decoded: Extract<ProcessRefDecode, { kind: 'decoded' }>;
      observation: Extract<ProcessRefObservation, { kind: 'gone' }>;
    }
  | {
      kind: 'unknown';
      reason: string;
      decoded: ProcessRefDecode;
      observation?: Extract<ProcessRefObservation, { kind: 'unknown' }>;
    };

/** Decode and inspect one persisted identity without interpreting its OS fields. */
export function inspectWatchdogProcessRef(
  input: unknown,
  pid: number | undefined,
  deps?: WatchdogProcessDeps,
): WatchdogProcessRefInspection {
  const decoded = (deps?.decodeProcessRef ?? decodeProcessRef)(input);
  if (decoded.kind !== 'decoded') {
    const reason = decoded.kind === 'unsupported_version' ? decoded.kind : decoded.reason;
    getAuditWriter()?.write(
      WATCHDOG_AUDIT_EVENTS.PID_OBSERVATION_UNKNOWN,
      `pid=${pid ?? 'unknown'}`,
      `reason=${reason}`,
      `evidence=${JSON.stringify(decoded.evidence)}`,
    );
    return { kind: 'unknown', reason, decoded };
  }

  const observation = (pid !== undefined ? refOverride(pid) : undefined)
    ?? (deps?.inspectProcessRef ?? inspectProcessRef)(decoded.value);
  if (observation.kind === 'alive') return { kind: 'alive', decoded, observation };
  if (observation.kind === 'gone') {
    return { kind: 'gone', reason: observation.reason, decoded, observation };
  }
  getAuditWriter()?.write(
    WATCHDOG_AUDIT_EVENTS.PID_OBSERVATION_UNKNOWN,
    `pid=${pid ?? 'unknown'}`,
    `reason=${observation.reason}`,
    `evidence=${JSON.stringify(observation.evidence)}`,
  );
  return { kind: 'unknown', reason: observation.reason, decoded, observation };
}

/** Schema 1 is adapted only to L1's v0 input; schema 2 stores an opaque ref. */
export function inspectWatchdogOwnerRecord(
  owner: WatchdogOwnerRecord,
  deps?: WatchdogProcessDeps,
): WatchdogProcessRefInspection {
  const input = owner.schema_version === 2
    ? owner.process_ref
    : {
        version: 0,
        pid: owner.pid,
        ...(owner.process_start_time !== 'unknown'
          ? { startTime: owner.process_start_time }
          : {}),
      };
  return inspectWatchdogProcessRef(input, owner.pid, deps);
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

/** Map dynamic L1 facts to Watchdog facts without flattening unknown. */
export function observeWatchdogProcess(
  pid: number,
  deps?: WatchdogProcessDeps,
): WatchdogProcessFact {
  const target = watchdogProcessTarget(pid);
  const observation = targetOverride(pid)
    ?? deps?.observeProcessTarget?.(target)
    ?? observeProcessTarget(target);
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
      signal: deps?.kill ?? defaultKill,
      ...(deps?.observeProcessTarget !== undefined
        ? { observeTarget: deps.observeProcessTarget }
        : {}),
    });
}
