import { hostname } from 'node:os';
import {
  encodeProcessEvidence,
  type ProcessEvidence,
  type ProcessEvidenceValue,
} from './process-evidence.js';
import {
  observeProcess,
  type ObservationFact,
  type ProcessObservation,
} from './process-observation.js';

declare const processRefBrand: unique symbol;
export type ProcessRef = string & { readonly [processRefBrand]: true };

export type ProcessUnavailableReason = 'permission_denied' | 'unsupported'
  | 'query_failed' | 'timed_out' | 'identity_unverifiable' | 'incomplete_data';

export type ProcessRefDecode =
  | { kind: 'decoded'; value: ProcessRef }
  | { kind: 'invalid'; reason: string; evidence: ProcessEvidence }
  | { kind: 'unsupported_version'; evidence: ProcessEvidence };

export type ProcessRefCapture =
  | { kind: 'captured'; value: ProcessRef; evidence: ProcessEvidence }
  | { kind: 'gone'; evidence: ProcessEvidence }
  | { kind: 'unknown'; reason: ProcessUnavailableReason; evidence: ProcessEvidence };

export type ProcessRefObservation =
  | { kind: 'alive'; evidence: ProcessEvidence }
  | { kind: 'gone'; reason: 'absent' | 'identity_changed'; evidence: ProcessEvidence }
  | { kind: 'unknown'; reason: ProcessUnavailableReason; evidence: ProcessEvidence };

type SupportedPlatform = 'darwin' | 'linux';
type ProcessSource = {
  platform: SupportedPlatform;
  hostname: string;
  tzEnv: string | null;
  timeZone: string;
};
type InternalRef =
  | {
      version: 1; pid: number; startTime: string; source: ProcessSource;
      basis: 'posix-lstart-second'; capturedAtMs: number;
    }
  | { version: 0; pid: number; startTime?: string };

type HostContext = Omit<ProcessSource, 'platform'> & { platform: string };
type ContextRead =
  | { kind: 'ok'; context: HostContext }
  | { kind: 'error'; error: unknown };
type InternalDecode =
  | { kind: 'decoded'; value: ProcessRef; internal: InternalRef }
  | Exclude<ProcessRefDecode, { kind: 'decoded' }>;

// Keep this validation in L1: consumers must not parse or brand process times.
const LSTART = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(?:[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/;
const MAX_DATE_MS = 8_640_000_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key));
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function decodeFailure(
  kind: 'invalid' | 'unsupported_version',
  raw: unknown,
  reason?: string,
  error?: unknown,
): Exclude<ProcessRefDecode, { kind: 'decoded' }> {
  const outcome: Record<string, unknown> = { operation: 'decode', outcome: kind, input: raw };
  if (reason !== undefined) outcome.reason = reason;
  if (error !== undefined) outcome.error = error;
  const evidence = encodeProcessEvidence(Date.now(), [outcome]);
  return kind === 'invalid'
    ? { kind, reason: reason ?? 'invalid_reference', evidence }
    : { kind, evidence };
}

function decodeInternal(raw: unknown): InternalDecode {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw) as unknown;
    } catch (error) {
      // silent: malformed JSON is returned as a typed result with the original error encoded.
      return decodeFailure('invalid', raw, 'malformed_json', error);
    }
  }
  try {
    if (!isRecord(candidate)) return decodeFailure('invalid', raw, 'expected_reference_object');
    if (typeof candidate.version === 'number' && Number.isSafeInteger(candidate.version)
        && candidate.version > 1) {
      return decodeFailure('unsupported_version', raw);
    }
    if (candidate.version !== 0 && candidate.version !== 1) {
      return decodeFailure('invalid', raw, 'unsupported_or_missing_version');
    }
    if (candidate.version === 0) {
      if (!hasOnlyKeys(candidate, ['version', 'pid', 'startTime'])
          || !hasOwn(candidate, 'version') || !hasOwn(candidate, 'pid')
          || !validPid(candidate.pid)) {
        return decodeFailure('invalid', raw, 'invalid_v0_shape_or_pid');
      }
      if (hasOwn(candidate, 'startTime') && candidate.startTime !== undefined
          && typeof candidate.startTime !== 'string') {
        return decodeFailure('invalid', raw, 'invalid_v0_start_time');
      }
      const internal: InternalRef = { version: 0, pid: candidate.pid };
      if (typeof candidate.startTime === 'string') internal.startTime = candidate.startTime;
      const value = (typeof raw === 'string' ? raw : JSON.stringify(internal)) as ProcessRef;
      return { kind: 'decoded', value, internal };
    }

    if (typeof raw !== 'string') return decodeFailure('invalid', raw, 'v1_requires_string_reference');
    if (!hasOnlyKeys(candidate, [
      'version', 'pid', 'startTime', 'source', 'basis', 'capturedAtMs',
    ]) || !hasOwn(candidate, 'pid') || !validPid(candidate.pid)
        || typeof candidate.startTime !== 'string' || !LSTART.test(candidate.startTime)
        || candidate.basis !== 'posix-lstart-second'
        || typeof candidate.capturedAtMs !== 'number'
        || !Number.isSafeInteger(candidate.capturedAtMs) || candidate.capturedAtMs < 0
        || candidate.capturedAtMs > MAX_DATE_MS) {
      return decodeFailure('invalid', raw, 'invalid_v1_reference');
    }
    const source = candidate.source;
    if (!isRecord(source) || !hasOnlyKeys(source, ['platform', 'hostname', 'tzEnv', 'timeZone'])
        || (source.platform !== 'darwin' && source.platform !== 'linux')
        || typeof source.hostname !== 'string'
        || (source.tzEnv !== null && typeof source.tzEnv !== 'string')
        || typeof source.timeZone !== 'string' || source.timeZone.length === 0) {
      return decodeFailure('invalid', raw, 'invalid_v1_source');
    }
    const internal: InternalRef = {
      version: 1,
      pid: candidate.pid,
      startTime: candidate.startTime,
      source: {
        platform: source.platform,
        hostname: source.hostname,
        tzEnv: source.tzEnv,
        timeZone: source.timeZone,
      },
      basis: 'posix-lstart-second',
      capturedAtMs: candidate.capturedAtMs,
    };
    return { kind: 'decoded', value: raw as ProcessRef, internal };
  } catch (error) {
    // silent: invalid reference structures are returned with complete encoded failure evidence.
    return decodeFailure('invalid', raw, 'reference_inspection_threw', error);
  }
}

function readContext(phase: 'before' | 'after', facts: unknown[]): ContextRead {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const host = hostname();
    if (typeof timeZone !== 'string' || timeZone.length === 0 || typeof host !== 'string') {
      throw new TypeError('The host process-time context is incomplete');
    }
    const context: HostContext = {
      platform: process.platform,
      hostname: host,
      tzEnv: typeof process.env.TZ === 'string' ? process.env.TZ : null,
      timeZone,
    };
    facts.push({ operation: 'context', phase, outcome: 'result', context });
    return { kind: 'ok', context };
  } catch (error) {
    facts.push({ operation: 'context', phase, outcome: 'throw', error });
    return { kind: 'error', error };
  }
}

function sameContext(left: HostContext, right: HostContext): boolean {
  return left.platform === right.platform
    && left.hostname === right.hostname
    && left.tzEnv === right.tzEnv
    && left.timeZone === right.timeZone;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined;
}

function observationErrors(evidence: readonly ObservationFact[]): unknown[] {
  const errors: unknown[] = [];
  for (const fact of evidence) {
    if (fact.outcome === 'error' || fact.outcome === 'throw') errors.push(fact.error);
    if (fact.operation === 'start_time' && fact.outcome === 'result' && fact.raw.error) {
      errors.push(fact.raw.error);
    }
  }
  return errors;
}

function observationUnavailableReason(
  observation: Extract<ProcessObservation, { kind: 'unknown' }>,
): ProcessUnavailableReason {
  if (observation.reason === 'unsupported_platform') return 'unsupported';
  if (observation.reason === 'invalid_pid' || observation.reason === 'malformed_start_time') {
    return 'incomplete_data';
  }
  const codes = observationErrors(observation.evidence).map(errorCode);
  if (codes.some(code => code === 'EPERM' || code === 'EACCES')) return 'permission_denied';
  if (codes.some(code => code === 'ETIMEDOUT')) return 'timed_out';
  if (observation.reason === 'start_time_unavailable') {
    const raw = observation.evidence.find(fact => fact.operation === 'start_time'
      && fact.outcome === 'result');
    if (raw?.operation === 'start_time' && raw.outcome === 'result'
        && !raw.raw.error && raw.raw.status === 0 && raw.raw.signal === null
        && (!Buffer.isBuffer(raw.raw.stdout) || !Buffer.isBuffer(raw.raw.stderr)
          || (raw.raw.stderr.length === 0 && raw.raw.stdout.length === 0))) {
      return 'incomplete_data';
    }
  }
  return 'query_failed';
}

function appendDecision(facts: unknown[], decision: ProcessEvidenceValue): void {
  facts.push({ operation: 'decision', outcome: decision });
}

/** Decode a persisted reference without consulting the operating system. */
export function decodeProcessRef(raw: unknown): ProcessRefDecode {
  const decoded = decodeInternal(raw);
  if (decoded.kind === 'decoded') return { kind: 'decoded', value: decoded.value };
  return decoded;
}

/** Capture only the current process; arbitrary PID capture is intentionally absent. */
export function captureCurrentProcessRef(): ProcessRefCapture {
  const atMs = Date.now();
  const pid = process.pid;
  const facts: unknown[] = [{ operation: 'capture', outcome: 'start', pid }];
  const finishUnknown = (reason: ProcessUnavailableReason): ProcessRefCapture => {
    appendDecision(facts, { kind: 'unknown', reason });
    return { kind: 'unknown', reason, evidence: encodeProcessEvidence(atMs, facts) };
  };

  const before = readContext('before', facts);
  if (before.kind === 'error') return finishUnknown('identity_unverifiable');
  const observation = observeProcess(pid);
  facts.push({ operation: 'observe', outcome: observation });
  const after = readContext('after', facts);
  if (before.context.platform !== 'darwin' && before.context.platform !== 'linux') {
    return finishUnknown('unsupported');
  }
  if (after.kind === 'error' || !sameContext(before.context, after.context)) {
    return finishUnknown('identity_unverifiable');
  }
  if (observation.kind === 'gone') {
    appendDecision(facts, { kind: 'gone', reason: 'absent' });
    return { kind: 'gone', evidence: encodeProcessEvidence(atMs, facts) };
  }
  if (observation.kind === 'unknown') return finishUnknown(observationUnavailableReason(observation));

  const internal: InternalRef = {
    version: 1,
    pid,
    startTime: observation.startTime,
    source: {
      platform: before.context.platform,
      hostname: before.context.hostname,
      tzEnv: before.context.tzEnv,
      timeZone: before.context.timeZone,
    },
    basis: 'posix-lstart-second',
    capturedAtMs: atMs,
  };
  const value = JSON.stringify(internal) as ProcessRef;
  appendDecision(facts, { kind: 'captured', compatibility: 'v1', reference: internal });
  return { kind: 'captured', value, evidence: encodeProcessEvidence(atMs, facts) };
}

/**
 * Inspect a decoded or forcibly-branded reference. No result is permission to
 * signal a process; v0 presence and all foreign/uncertain contexts stay unknown.
 */
export function inspectProcessRef(ref: ProcessRef): ProcessRefObservation {
  const atMs = Date.now();
  const decoded = decodeInternal(ref);
  if (decoded.kind !== 'decoded') {
    const reason: ProcessUnavailableReason = decoded.kind === 'unsupported_version'
      ? 'unsupported'
      : 'identity_unverifiable';
    const evidence = encodeProcessEvidence(atMs, [
      { operation: 'decode', outcome: decoded },
      { operation: 'decision', outcome: { kind: 'unknown', reason } },
    ]);
    return { kind: 'unknown', reason, evidence };
  }

  const internal = decoded.internal;
  const compatibility = internal.version === 0 ? 'legacy-v0' : 'v1';
  const facts: unknown[] = [{
    operation: 'inspect', outcome: 'start', compatibility, reference: internal,
  }];
  const finishUnknown = (reason: ProcessUnavailableReason): ProcessRefObservation => {
    appendDecision(facts, { kind: 'unknown', reason });
    return { kind: 'unknown', reason, evidence: encodeProcessEvidence(atMs, facts) };
  };

  if (internal.version === 0) {
    const observation = observeProcess(internal.pid);
    facts.push({ operation: 'observe', outcome: observation });
    if (observation.kind === 'gone') {
      appendDecision(facts, {
        kind: 'gone', reason: 'absent', compatibility,
        scope: 'same-host-configuration-directory-only',
      });
      return { kind: 'gone', reason: 'absent', evidence: encodeProcessEvidence(atMs, facts) };
    }
    if (observation.kind === 'unknown') return finishUnknown(observationUnavailableReason(observation));
    // Never promote a legacy string comparison to proof of PID reuse or identity.
    return finishUnknown('identity_unverifiable');
  }

  const before = readContext('before', facts);
  if (before.kind === 'error') return finishUnknown('identity_unverifiable');
  if (!sameContext(internal.source, before.context)) {
    return finishUnknown('identity_unverifiable');
  }
  const observation = observeProcess(internal.pid);
  facts.push({ operation: 'observe', outcome: observation });
  const after = readContext('after', facts);
  if (after.kind === 'error' || !sameContext(before.context, after.context)
      || !sameContext(internal.source, after.context)) {
    return finishUnknown('identity_unverifiable');
  }
  if (observation.kind === 'gone') {
    appendDecision(facts, { kind: 'gone', reason: 'absent', compatibility });
    return { kind: 'gone', reason: 'absent', evidence: encodeProcessEvidence(atMs, facts) };
  }
  if (observation.kind === 'unknown') return finishUnknown(observationUnavailableReason(observation));
  if (observation.startTime !== internal.startTime) {
    appendDecision(facts, { kind: 'gone', reason: 'identity_changed', compatibility });
    return { kind: 'gone', reason: 'identity_changed', evidence: encodeProcessEvidence(atMs, facts) };
  }
  appendDecision(facts, { kind: 'alive', compatibility });
  return { kind: 'alive', evidence: encodeProcessEvidence(atMs, facts) };
}
