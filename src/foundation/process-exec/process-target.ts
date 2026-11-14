/**
 * Typed, single-process observation and termination capabilities.
 *
 * Raw signal/ps behaviour stays in ProcessExec. Callers provide the legacy
 * identity they persisted and consume alive/gone/unknown plus termination
 * evidence; no business generation or stop-intent policy lives here.
 */
import { encodeProcessEvidence, type ProcessEvidence } from './process-evidence.js';
import { observeProcess, type ProcessObservation } from './process-observation.js';
import {
  commandContainsToken,
  observePidArgv,
  type ProcessArgvObservation,
} from './argv-verify.js';
import { kill } from './process-control.js';
import type { ProcessStartTime } from './process-starttime.js';
import {
  observationError,
  observationUnavailableReason,
} from './process-reference.js';
import type { ProcessInfo, ProcessTarget, ProcessUnavailableReason } from './types.js';

export type ProcessTargetObservation =
  | { kind: 'alive'; startTime?: ProcessStartTime; evidence: ProcessEvidence }
  | { kind: 'gone'; reason: 'absent' | 'identity_changed'; evidence: ProcessEvidence }
  | { kind: 'unknown'; reason: ProcessUnavailableReason; evidence: ProcessEvidence; error?: unknown };

export interface ProcessObservationAdapters {
  /** Compatibility seam for existing callers' injected L1 probe. */
  legacyProbe?: (pid: number, startTime?: ProcessStartTime) => boolean;
  /** Test seam for the raw L1 observation, not for business code. */
  observe?: (pid: number) => ProcessObservation;
  /** Legacy boolean argv adapter; production defaults to typed argv observation. */
  argvMatch?: (pid: number, token: string) => boolean;
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

function mergeEvidence(...values: ProcessEvidence[]): ProcessEvidence {
  return { version: 1, atMs: Date.now(), facts: values.flatMap(value => value.facts) };
}

function unknownFromError(error: unknown, evidence: ProcessEvidence): ProcessTargetObservation {
  const code = errorCode(error);
  const reason: ProcessUnavailableReason = code === 'EPERM' || code === 'EACCES'
    ? 'permission_denied'
    : code === 'ETIMEDOUT' ? 'timed_out' : 'query_failed';
  return { kind: 'unknown', reason, evidence, error };
}

function observeArgv(
  target: ProcessTarget,
  adapters: ProcessObservationAdapters,
): ProcessArgvObservation {
  const token = target.argvToken!;
  if (adapters.argvMatch === undefined) return observePidArgv(target.pid, token);
  try {
    const matches = adapters.argvMatch(target.pid, token);
    return {
      kind: matches ? 'match' : 'mismatch',
      evidence: encodeProcessEvidence(Date.now(), [{
        operation: 'legacy_argv_probe', outcome: matches ? 'match' : 'mismatch', target,
      }]),
    };
  } catch (error) {
    const unknown = unknownFromError(error, encodeProcessEvidence(Date.now(), [{
      operation: 'legacy_argv_probe', outcome: 'throw', target, error,
    }]));
    return {
      kind: 'unknown',
      reason: unknown.kind === 'unknown' ? unknown.reason : 'query_failed',
      evidence: unknown.evidence,
      error,
    };
  }
}

function applyArgvIdentity(
  target: ProcessTarget,
  startTime: ProcessStartTime | undefined,
  evidence: ProcessEvidence,
  adapters: ProcessObservationAdapters,
): ProcessTargetObservation {
  if (target.argvToken === undefined) {
    return { kind: 'alive', ...(startTime !== undefined ? { startTime } : {}), evidence };
  }
  const argv = observeArgv(target, adapters);
  const combined = mergeEvidence(evidence, argv.evidence);
  if (argv.kind === 'match') {
    return { kind: 'alive', ...(startTime !== undefined ? { startTime } : {}), evidence: combined };
  }
  if (argv.kind === 'gone') return { kind: 'gone', reason: 'absent', evidence: combined };
  if (argv.kind === 'mismatch') {
    return { kind: 'gone', reason: 'identity_changed', evidence: combined };
  }
  return {
    kind: 'unknown', reason: argv.reason, evidence: combined,
    ...(argv.error !== undefined ? { error: argv.error } : {}),
  };
}

function observedResult(
  observation: ProcessObservation,
  target: ProcessTarget,
  adapters: ProcessObservationAdapters,
): ProcessTargetObservation {
  const evidence = encodeProcessEvidence(Date.now(), [observation]);
  if (observation.kind === 'gone') return { kind: 'gone', reason: 'absent', evidence };
  if (observation.kind === 'unknown') {
    const error = observationError(observation);
    return {
      kind: 'unknown', reason: observationUnavailableReason(observation), evidence,
      ...(error !== undefined ? { error } : {}),
    };
  }
  if (target.startTime !== undefined && observation.startTime !== target.startTime) {
    return { kind: 'gone', reason: 'identity_changed', evidence };
  }
  return applyArgvIdentity(target, observation.startTime, evidence, adapters);
}

export type ProcessTargetCapture =
  | { kind: 'captured'; target: ProcessTarget; evidence: ProcessEvidence }
  | { kind: 'gone'; evidence: ProcessEvidence }
  | { kind: 'unknown'; reason: ProcessUnavailableReason; evidence: ProcessEvidence; error?: unknown };

function captureObservedProcessTarget(
  pid: number,
  observe: (pid: number) => ProcessObservation,
  operation: 'capture_identity' | 'capture_current_identity',
): ProcessTargetCapture {
  try {
    const observation = observe(pid);
    const evidence = encodeProcessEvidence(Date.now(), [observation]);
    if (observation.kind === 'gone') return { kind: 'gone', evidence };
    if (observation.kind === 'unknown') {
      const error = observationError(observation);
      return {
        kind: 'unknown', reason: observationUnavailableReason(observation), evidence,
        ...(error !== undefined ? { error } : {}),
      };
    }
    return {
      kind: 'captured',
      target: { pid, startTime: observation.startTime },
      evidence,
    };
  } catch (error) {
    return {
      kind: 'unknown', reason: 'query_failed', error,
      evidence: encodeProcessEvidence(Date.now(), [{ operation, outcome: 'throw', pid, error }]),
    };
  }
}

/** Capture identity through typed observation, retaining the legacy probe seam. */
export function captureProcessTarget(
  pid: number,
  legacyStartTime?: (pid: number) => ProcessStartTime | undefined,
): ProcessTargetCapture {
  if (legacyStartTime === undefined) {
    return captureObservedProcessTarget(pid, observeProcess, 'capture_identity');
  }
  try {
    const startTime = legacyStartTime(pid);
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

/**
 * Capture the current process through the evidence-preserving OS observation
 * path. Unknown identity never fabricates a start time; raw probe failures stay
 * encoded in the returned evidence for the caller's own audit policy.
 */
export function captureCurrentProcessIdentity(
  observe: (pid: number) => ProcessObservation = observeProcess,
): ProcessTargetCapture {
  return captureObservedProcessTarget(process.pid, observe, 'capture_current_identity');
}

/** Explicit test seam for legacy boolean callers; production uses observeProcessTarget. */
export function observeProcessTargetWithLegacyProbeForTest(
  target: ProcessTarget,
  adapters: Pick<ProcessObservationAdapters, 'legacyProbe' | 'argvMatch'>,
): ProcessTargetObservation {
  return observeProcessTarget(target, adapters);
}

/** Observe a persisted PID/start-time identity without flattening failures. */
export function observeProcessTarget(
  target: ProcessTarget,
  adapters: ProcessObservationAdapters = {},
): ProcessTargetObservation {
  if (adapters.legacyProbe === undefined) {
    return observedResult((adapters.observe ?? observeProcess)(target.pid), target, adapters);
  }

  try {
    const alive = adapters.legacyProbe(target.pid, target.startTime);
    const evidence = encodeProcessEvidence(Date.now(), [{
      operation: 'legacy_probe', outcome: alive ? 'alive' : 'gone', target,
    }]);
    return alive
      ? applyArgvIdentity(target, target.startTime, evidence, adapters)
      : { kind: 'gone', reason: 'absent', evidence };
  } catch (error) {
    const evidence = encodeProcessEvidence(Date.now(), [{
      operation: 'legacy_probe', outcome: 'throw', target, error,
    }]);
    if (errorCode(error) === 'ESRCH') return { kind: 'gone', reason: 'absent', evidence };
    return unknownFromError(error, evidence);
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

  // Plain legacy targets preserve the old fire-then-probe test seam. An argv
  // identity always requires a safe pre-signal observation, including adapters.
  if (adapters.legacyProbe === undefined || target.argvToken !== undefined) {
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
  /** Legacy single-token match; structured callers should provide requiredArgvTokens. */
  requiredArgvToken: string;
  /** Complete literal argv tokens that must all match; no shell parsing or substring guesses. */
  requiredArgvTokens?: readonly string[];
  excludePid?: number;
  graceMs?: number;
  list: () => ProcessInfo[] | Promise<ProcessInfo[]>;
  signal?: (pid: number, signal: 'TERM' | 'KILL') => void;
}

/** Match a daemon-dir-style token in L1; callers never split ps command text. */
export function processCommandContainsToken(command: string, token: string): boolean {
  return commandContainsToken(command, token);
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
  const requiredTokens = options.requiredArgvTokens ?? [options.requiredArgvToken];
  const matches = (command: string): boolean => requiredTokens.every(token =>
    processCommandContainsToken(command, token));
  let processes: ProcessInfo[];
  try {
    processes = await options.list();
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
    if (!matches(proc.command)) {
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
    remaining = await options.list();
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
    .filter(proc => candidates.includes(proc.pid) && matches(proc.command))
    .map(proc => proc.pid);
  if (survived.length > 0) {
    return {
      kind: 'blocked', stage: 'verify', pids: survived,
      error: new Error(`matching processes still alive after SIGTERM: ${survived.join(', ')}`),
    };
  }
  return { kind: 'clear', terminated: candidates.length, pids: candidates, skipped };
}
