/**
 * Typed, single-process observation and termination capabilities.
 *
 * Raw signal/ps behaviour stays in ProcessExec. Callers provide the legacy
 * identity they persisted and consume alive/gone/unknown plus termination
 * evidence; no business generation or stop-intent policy lives here.
 */
import { encodeProcessEvidence, type ProcessEvidence } from './process-evidence.js';
import { observeProcess, type ProcessObservation } from './process-observation.js';
import { kill } from './process-control.js';
import { getProcessStartTime, type ProcessStartTime } from './process-starttime.js';
import type { ProcessUnavailableReason } from './process-reference.js';
import type { ProcessInfo } from './types.js';

export interface ProcessTarget {
  pid: number;
  startTime?: ProcessStartTime;
}

export type ProcessTargetObservation =
  | { kind: 'alive'; startTime?: ProcessStartTime; evidence: ProcessEvidence }
  | { kind: 'gone'; reason: 'absent' | 'identity_changed'; evidence: ProcessEvidence }
  | { kind: 'unknown'; reason: ProcessUnavailableReason; evidence: ProcessEvidence; error?: unknown };

export interface ProcessObservationAdapters {
  /** Compatibility seam for existing callers' injected L1 probe. */
  legacyProbe?: (pid: number, startTime?: ProcessStartTime) => boolean;
  /** Test seam for the raw L1 observation, not for PM business code. */
  observe?: (pid: number) => ProcessObservation;
}

export interface ProcessTerminationOptions {
  graceMs?: number;
  confirmMs?: number;
  pollIntervalMs?: number;
}

export type ProcessTerminationOutcome =
  | {
      kind: 'gone';
      via: 'already_gone' | 'sigterm' | 'sigkill';
      termSent: boolean;
      killSent: boolean;
      evidence: ProcessEvidence;
    }
  | {
      kind: 'still_alive';
      termSent: boolean;
      killSent: boolean;
      evidence: ProcessEvidence;
    }
  | {
      kind: 'indeterminate';
      stage: 'observe' | 'sigterm' | 'sigkill';
      error: unknown;
      termSent: boolean;
      killSent: boolean;
      evidence: ProcessEvidence;
    };

export interface ProcessTerminationAdapters extends ProcessObservationAdapters {
  signal?: (pid: number, signal: 'TERM' | 'KILL') => void;
  observeTarget?: (target: ProcessTarget) => ProcessTargetObservation;
}

const DEFAULT_TERMINATION_GRACE_MS = 5000;
const DEFAULT_KILL_CONFIRM_MS = 1000;
const DEFAULT_TERMINATION_POLL_MS = 100;

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined;
}

function observationErrors(observation: Extract<ProcessObservation, { kind: 'unknown' }>): unknown[] {
  const errors: unknown[] = [];
  for (const fact of observation.evidence) {
    if (fact.outcome === 'error' || fact.outcome === 'throw') errors.push(fact.error);
    if (fact.operation === 'start_time' && fact.outcome === 'result' && fact.raw.error) {
      errors.push(fact.raw.error);
    }
  }
  return errors;
}

function unavailableReason(
  observation: Extract<ProcessObservation, { kind: 'unknown' }>,
): ProcessUnavailableReason {
  if (observation.reason === 'unsupported_platform') return 'unsupported';
  if (observation.reason === 'invalid_pid' || observation.reason === 'malformed_start_time') {
    return 'incomplete_data';
  }
  const codes = observationErrors(observation).map(errorCode);
  if (codes.some(code => code === 'EPERM' || code === 'EACCES')) return 'permission_denied';
  if (codes.some(code => code === 'ETIMEDOUT')) return 'timed_out';
  return 'query_failed';
}

function observedResult(
  observation: ProcessObservation,
  expectedStartTime: ProcessStartTime | undefined,
): ProcessTargetObservation {
  const evidence = encodeProcessEvidence(Date.now(), [observation]);
  if (observation.kind === 'gone') return { kind: 'gone', reason: 'absent', evidence };
  if (observation.kind === 'unknown') {
    return { kind: 'unknown', reason: unavailableReason(observation), evidence };
  }
  if (expectedStartTime !== undefined && observation.startTime !== expectedStartTime) {
    return { kind: 'gone', reason: 'identity_changed', evidence };
  }
  return { kind: 'alive', startTime: observation.startTime, evidence };
}

export type ProcessTargetCapture =
  | { kind: 'captured'; target: ProcessTarget; evidence: ProcessEvidence }
  | { kind: 'gone'; evidence: ProcessEvidence }
  | { kind: 'unknown'; reason: ProcessUnavailableReason; evidence: ProcessEvidence; error?: unknown };

/** Capture current identity metadata without exposing raw ps output to callers. */
export function captureProcessTarget(
  pid: number,
  legacyStartTime?: (pid: number) => ProcessStartTime | undefined,
): ProcessTargetCapture {
  try {
    const startTime = (legacyStartTime ?? getProcessStartTime)(pid);
    const evidence = encodeProcessEvidence(Date.now(), [{
      operation: 'capture_identity', outcome: startTime === undefined ? 'unknown' : 'captured', pid,
    }]);
    if (startTime === undefined) {
      return { kind: 'unknown', reason: 'incomplete_data', evidence };
    }
    return { kind: 'captured', target: { pid, startTime }, evidence };
  } catch (error) {
    return {
      kind: 'unknown', reason: 'query_failed', error,
      evidence: encodeProcessEvidence(Date.now(), [{
        operation: 'capture_identity', outcome: 'throw', pid, error,
      }]),
    };
  }
}

/** Observe a persisted PID/start-time identity without flattening failures. */
export function observeProcessTarget(
  target: ProcessTarget,
  adapters: ProcessObservationAdapters = {},
): ProcessTargetObservation {
  if (adapters.legacyProbe === undefined) {
    return observedResult((adapters.observe ?? observeProcess)(target.pid), target.startTime);
  }

  try {
    const alive = adapters.legacyProbe(target.pid, target.startTime);
    const evidence = encodeProcessEvidence(Date.now(), [{
      operation: 'legacy_probe', outcome: alive ? 'alive' : 'gone', target,
    }]);
    return alive
      ? { kind: 'alive', ...(target.startTime !== undefined ? { startTime: target.startTime } : {}), evidence }
      : { kind: 'gone', reason: 'absent', evidence };
  } catch (error) {
    const evidence = encodeProcessEvidence(Date.now(), [{
      operation: 'legacy_probe', outcome: 'throw', target, error,
    }]);
    if (errorCode(error) === 'ESRCH') return { kind: 'gone', reason: 'absent', evidence };
    const code = errorCode(error);
    const reason: ProcessUnavailableReason = code === 'EPERM' || code === 'EACCES'
      ? 'permission_denied'
      : code === 'ETIMEDOUT' ? 'timed_out' : 'query_failed';
    return { kind: 'unknown', reason, evidence, error };
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run TERM → bounded grace → KILL → bounded confirmation for one identity.
 * Unknown observations never authorize a signal and are never reported gone.
 */
export async function terminateProcessTarget(
  target: ProcessTarget,
  options: ProcessTerminationOptions = {},
  adapters: ProcessTerminationAdapters = {},
): Promise<ProcessTerminationOutcome> {
  const graceMs = options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const confirmMs = options.confirmMs ?? DEFAULT_KILL_CONFIRM_MS;
  const pollMs = options.pollIntervalMs ?? DEFAULT_TERMINATION_POLL_MS;
  const signal = adapters.signal ?? kill;
  let termSent = false;
  let killSent = false;
  let lastEvidence = encodeProcessEvidence(Date.now(), [{ operation: 'terminate', outcome: 'start', target }]);

  const observe = (): ProcessTargetObservation => {
    const result = adapters.observeTarget?.(target) ?? observeProcessTarget(target, adapters);
    lastEvidence = result.evidence;
    return result;
  };
  const indeterminate = (
    stage: 'observe' | 'sigterm' | 'sigkill',
    error: unknown,
  ): ProcessTerminationOutcome => ({
    kind: 'indeterminate', stage, error, termSent, killSent, evidence: lastEvidence,
  });
  const send = (value: 'TERM' | 'KILL'): 'sent' | 'gone' => {
    try {
      signal(target.pid, value);
      return 'sent';
    } catch (error) {
      lastEvidence = encodeProcessEvidence(Date.now(), [{
        operation: 'signal', outcome: 'throw', signal: value, target, error,
      }]);
      if (errorCode(error) === 'ESRCH') return 'gone';
      throw error;
    }
  };
  const waitGone = async (
    budgetMs: number,
  ): Promise<ProcessTargetObservation | undefined> => {
    // Iteration budget also terminates under a frozen/mocked wall clock.
    let remainingMs = budgetMs;
    for (;;) {
      const result = observe();
      if (result.kind !== 'alive') return result;
      if (remainingMs <= 0) return undefined;
      await sleep(Math.min(pollMs, remainingMs));
      remainingMs -= pollMs;
    }
  };

  // The explicit legacy adapter preserves the old fire-then-probe test seam.
  // Production typed observation refuses to signal when identity is unknown.
  if (adapters.legacyProbe === undefined) {
    const initial = observe();
    if (initial.kind === 'gone') {
      return { kind: 'gone', via: 'already_gone', termSent, killSent, evidence: initial.evidence };
    }
    if (initial.kind === 'unknown') return indeterminate('observe', initial);
  }

  try {
    if (send('TERM') === 'gone') {
      return { kind: 'gone', via: 'sigterm', termSent, killSent, evidence: lastEvidence };
    }
    termSent = true;
  } catch (error) {
    // silent: the original error is returned in the typed termination outcome.
    return indeterminate('sigterm', error);
  }

  const afterTerm = await waitGone(graceMs);
  if (afterTerm?.kind === 'gone') {
    return { kind: 'gone', via: 'sigterm', termSent, killSent, evidence: afterTerm.evidence };
  }
  if (afterTerm?.kind === 'unknown') return indeterminate('observe', afterTerm);

  try {
    if (send('KILL') === 'gone') {
      return { kind: 'gone', via: 'sigkill', termSent, killSent, evidence: lastEvidence };
    }
    killSent = true;
  } catch (error) {
    // silent: the original error is returned in the typed termination outcome.
    return indeterminate('sigkill', error);
  }

  const afterKill = await waitGone(confirmMs);
  if (afterKill?.kind === 'gone') {
    return { kind: 'gone', via: 'sigkill', termSent, killSent, evidence: afterKill.evidence };
  }
  if (afterKill?.kind === 'unknown') return indeterminate('observe', afterKill);
  return { kind: 'still_alive', termSent, killSent, evidence: lastEvidence };
}

export type ProcessMatchCleanupOutcome =
  | { kind: 'clear'; terminated: number; pids: number[]; skipped: number[] }
  | { kind: 'not_needed'; skipped: number[] }
  | {
      kind: 'blocked';
      stage: 'enumerate' | 'signal' | 'verify';
      error: unknown;
      pids: number[];
    };

export interface ProcessMatchCleanupOptions {
  pattern: string;
  requiredArgvToken: string;
  excludePid?: number;
  graceMs?: number;
  list: () => ProcessInfo[];
  signal?: (pid: number, signal: 'TERM' | 'KILL') => void;
}

/** Match a daemon-dir-style token in L1; callers never split ps command text. */
export function processCommandContainsToken(command: string, token: string): boolean {
  if (!command) return false;
  return command.split(/\s+/).filter(part => part.length > 0).includes(token);
}

/**
 * Terminate exact argv-token matches and verify those same PID/token identities
 * disappeared. Missing command evidence is blocked, not silently treated as a
 * non-match. A reused PID with different argv is no longer the original match.
 */
export async function terminateMatchingProcesses(
  options: ProcessMatchCleanupOptions,
): Promise<ProcessMatchCleanupOutcome> {
  const signal = options.signal ?? kill;
  let processes: ProcessInfo[];
  try {
    processes = options.list();
  } catch (error) {
    // silent: enumeration failure is returned with its original error evidence.
    return { kind: 'blocked', stage: 'enumerate', error, pids: [] };
  }

  const candidates: number[] = [];
  const skipped: number[] = [];
  for (const proc of processes) {
    if (proc.pid === options.excludePid) continue;
    if (!proc.command) {
      return {
        kind: 'blocked', stage: 'enumerate', pids: [proc.pid],
        error: new Error(`argv evidence unavailable for pid ${proc.pid}`),
      };
    }
    if (!processCommandContainsToken(proc.command, options.requiredArgvToken)) {
      skipped.push(proc.pid);
      continue;
    }
    candidates.push(proc.pid);
    try {
      signal(proc.pid, 'TERM');
    } catch (error) {
      // silent: signal failure is returned with candidate and original error evidence.
      return { kind: 'blocked', stage: 'signal', error, pids: candidates };
    }
  }
  if (candidates.length === 0) return { kind: 'not_needed', skipped };

  await sleep(options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS);
  let remaining: ProcessInfo[];
  try {
    remaining = options.list();
  } catch (error) {
    // silent: verification failure is returned with candidate and original error evidence.
    return { kind: 'blocked', stage: 'verify', error, pids: candidates };
  }
  for (const proc of remaining) {
    if (candidates.includes(proc.pid) && !proc.command) {
      return {
        kind: 'blocked', stage: 'verify', pids: [proc.pid],
        error: new Error(`argv verification unavailable for pid ${proc.pid}`),
      };
    }
  }
  const survived = remaining
    .filter(proc => candidates.includes(proc.pid)
      && processCommandContainsToken(proc.command, options.requiredArgvToken))
    .map(proc => proc.pid);
  if (survived.length > 0) {
    return {
      kind: 'blocked', stage: 'verify', pids: survived,
      error: new Error(`matching processes still alive after SIGTERM: ${survived.join(', ')}`),
    };
  }
  return { kind: 'clear', terminated: candidates.length, pids: candidates, skipped };
}
