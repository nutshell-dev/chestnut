import { encodeProcessEvidence, type ProcessEvidence } from './process-evidence.js';
import { observeProcess, type ProcessObservation } from './process-observation.js';
import type { ProcessStartTime } from './process-starttime.js';

export type ProcessStartTimeUnavailableReason =
  | 'invalid_pid'
  | 'pid_gone'
  | 'unsupported_platform'
  | 'permission_denied'
  | 'timed_out'
  | 'query_failed'
  | 'empty'
  | 'malformed';

export type ProcessStartTimeFact =
  | {
      kind: 'available';
      pid: number;
      startTime: ProcessStartTime;
      startedAtMs: number;
      precision: 'second';
      evidence: ProcessEvidence;
    }
  | {
      kind: 'unavailable';
      pid: number;
      reason: ProcessStartTimeUnavailableReason;
      evidence: ProcessEvidence;
    };

const LSTART = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) (\d{4})$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function decodeLstartToEpoch(raw: ProcessStartTime): number | undefined {
  const match = LSTART.exec(raw);
  if (!match) return undefined;
  const [, weekday, month, dayText, hourText, minuteText, secondText, yearText] = match;
  const year = Number(yearText);
  const monthIndex = MONTHS.indexOf(month as (typeof MONTHS)[number]);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  // ps lstart has no zone: interpret its calendar fields in the host zone inside L1.
  const date = new Date(0);
  date.setFullYear(year, monthIndex, day);
  date.setHours(hour, minute, second, 0);
  const startedAtMs = date.getTime();
  if (!Number.isFinite(startedAtMs)
      || date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day
      || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second
      || date.getDay() !== WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number])) {
    return undefined;
  }
  return startedAtMs;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined;
}

function errorName(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'name' in error
    ? (error as { name: unknown }).name
    : undefined;
}

function observationErrors(observation: ProcessObservation): unknown[] {
  return observation.evidence.flatMap(fact => {
    if (fact.outcome === 'error' || fact.outcome === 'throw') return [fact.error];
    if (fact.operation === 'start_time' && fact.outcome === 'result' && fact.raw.error) {
      return [fact.raw.error];
    }
    return [];
  });
}

function mapObservationFailure(
  observation: Extract<ProcessObservation, { kind: 'unknown' }>,
): ProcessStartTimeUnavailableReason {
  if (observation.reason === 'invalid_pid' || observation.reason === 'unsupported_platform') {
    return observation.reason;
  }
  if (observation.reason === 'malformed_start_time') return 'malformed';

  const errors = observationErrors(observation);
  if (errors.some(error => errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES')) {
    return 'permission_denied';
  }
  if (errors.some(error => errorCode(error) === 'ETIMEDOUT' || errorCode(error) === 'ABORT_ERR'
      || errorName(error) === 'TimeoutError' || errorName(error) === 'AbortError')) {
    return 'timed_out';
  }

  if (observation.reason === 'start_time_unavailable') {
    const query = observation.evidence.find(fact => fact.operation === 'start_time'
      && fact.outcome === 'result');
    if (query?.operation === 'start_time' && query.outcome === 'result'
        && !query.raw.error && query.raw.status === 0 && query.raw.signal === null
        && Buffer.isBuffer(query.raw.stdout) && Buffer.isBuffer(query.raw.stderr)
        && query.raw.stderr.length === 0 && query.raw.stdout.toString('utf8').trim().length === 0) {
      return 'empty';
    }
  }
  return 'query_failed';
}

/** @internal Map one bounded L1 observation without repeating its OS query. */
export function processStartTimeFactFromObservation(
  observation: ProcessObservation,
  atMs: number,
): ProcessStartTimeFact {
  const evidence = encodeProcessEvidence(atMs, [observation]);
  if (observation.kind === 'gone') {
    return { kind: 'unavailable', pid: observation.pid, reason: 'pid_gone', evidence };
  }
  if (observation.kind === 'unknown') {
    return {
      kind: 'unavailable',
      pid: observation.pid,
      reason: mapObservationFailure(observation),
      evidence,
    };
  }

  const startedAtMs = decodeLstartToEpoch(observation.startTime);
  if (startedAtMs === undefined) {
    return { kind: 'unavailable', pid: observation.pid, reason: 'malformed', evidence };
  }
  return {
    kind: 'available',
    pid: observation.pid,
    startTime: observation.startTime,
    startedAtMs,
    precision: 'second',
    evidence,
  };
}

/** Observe a PID once and return its decoded start time or a typed failure. */
export function observeProcessStartTime(pid: number): ProcessStartTimeFact {
  return processStartTimeFactFromObservation(observeProcess(pid), Date.now());
}
