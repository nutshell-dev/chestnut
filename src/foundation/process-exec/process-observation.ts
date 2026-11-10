/**
 * Private L1 observation, not a persisted identity or authorization to terminate.
 * Raw OS facts stay inside ProcessExec; public evidence needs its own encoding.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { PROCESS_EXEC_DEFAULT_MAX_BUFFER } from './constants.js';
import { makeProcessStartTime, type ProcessStartTime } from './process-starttime.js';

// Preserve the existing start-time query's one-second budget.
const PROCESS_OBSERVATION_TIMEOUT_MS = 1000;

export type ObservationFact =
  | { operation: 'signal0'; outcome: 'ok' }
  | { operation: 'signal0'; outcome: 'error'; error: unknown }
  | { operation: 'start_time'; outcome: 'result'; raw: SpawnSyncReturns<Buffer> }
  | { operation: 'start_time'; outcome: 'throw'; error: unknown };

export type ProcessObservation =
  | { kind: 'alive'; pid: number; startTime: ProcessStartTime; evidence: readonly ObservationFact[] }
  | { kind: 'gone'; pid: number; evidence: readonly ObservationFact[] }
  | { kind: 'unknown'; pid: number;
      reason: 'invalid_pid' | 'unsupported_platform' | 'probe_failed'
        | 'start_time_unavailable' | 'malformed_start_time';
      evidence: readonly ObservationFact[] };

type PresenceFact = Extract<ObservationFact, { operation: 'signal0' }>;

function probe(pid: number): PresenceFact {
  try {
    process.kill(pid, 0);
    return { operation: 'signal0', outcome: 'ok' };
  } catch (error) {
    return { error, operation: 'signal0', outcome: 'error' };
  }
}

function presence(fact: PresenceFact): 'present' | 'gone' | 'unknown' {
  if (fact.outcome === 'ok') return 'present';
  const error = fact.error;
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
    ? 'gone' : 'unknown';
}

// C-locale ps lstart syntax, with numeric ranges, without host date parsing.
// The original bytes (including padding) remain in the observation evidence.
const LSTART = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(?:[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/;

/**
 * Observe a PID on the current host. Even `alive` does not establish that this
 * is the same instance as an earlier observation (lstart has second precision).
 * No cache, persistent records, group operations or nonzero signals to the observed target.
 */
export function observeProcess(pid: number): ProcessObservation {
  const evidence: ObservationFact[] = [];
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { kind: 'unknown', pid, reason: 'invalid_pid', evidence };
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return { kind: 'unknown', pid, reason: 'unsupported_platform', evidence };
  }

  const beforeFact = probe(pid);
  evidence.push(beforeFact);
  const before = presence(beforeFact);
  if (before === 'gone') return { kind: 'gone', pid, evidence };
  if (before === 'unknown') return { kind: 'unknown', pid, reason: 'probe_failed', evidence };

  let raw: SpawnSyncReturns<Buffer> | undefined;
  try {
    raw = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROCESS_OBSERVATION_TIMEOUT_MS,
      maxBuffer: PROCESS_EXEC_DEFAULT_MAX_BUFFER,
      // Bound timeout cleanup even if the query tool ignores TERM.
      killSignal: 'SIGKILL',
    });
    evidence.push({ operation: 'start_time', outcome: 'result', raw });
  } catch (error) {
    evidence.push({ operation: 'start_time', outcome: 'throw', error });
  }

  const afterFact = probe(pid);
  evidence.push(afterFact);
  const after = presence(afterFact);
  if (after === 'gone') return { kind: 'gone', pid, evidence };
  if (after === 'unknown') return { kind: 'unknown', pid, reason: 'probe_failed', evidence };
  if (!raw || raw.error || raw.status !== 0 || raw.signal !== null
      || !Buffer.isBuffer(raw.stdout) || !Buffer.isBuffer(raw.stderr)
      || raw.stderr.length !== 0 || raw.stdout.length === 0) {
    return { kind: 'unknown', pid, reason: 'start_time_unavailable', evidence };
  }
  const startTime = raw.stdout.toString('utf8').trimEnd();
  if (startTime.length === 0) {
    return { kind: 'unknown', pid, reason: 'start_time_unavailable', evidence };
  }
  if (!LSTART.test(startTime)) {
    return { kind: 'unknown', pid, reason: 'malformed_start_time', evidence };
  }
  return { kind: 'alive', pid, startTime: makeProcessStartTime(startTime), evidence };
}
