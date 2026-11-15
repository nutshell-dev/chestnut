import { readFileSync } from 'node:fs';
import type { SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { makeProcessStartTime } from '../../../src/foundation/process-exec/process-starttime.js';
import {
  processStartTimeFactFromObservation,
  type ProcessStartTimeFact,
} from '../../../src/foundation/process-exec/process-starttime-fact.js';
import type {
  ObservationFact,
  ProcessObservation,
} from '../../../src/foundation/process-exec/process-observation.js';

const PID = 12345;
const AT_MS = 1_800_000_000_000;
const START = 'Tue Nov 10 13:27:59 2026';
const probeOk: ObservationFact = { operation: 'signal0', outcome: 'ok' };
const errno = (code: string) => Object.assign(new Error(code), { code });

function rawResult(overrides: Partial<SpawnSyncReturns<Buffer>> = {}): SpawnSyncReturns<Buffer> {
  const stdout = Buffer.from(`${START}\n`);
  const stderr = Buffer.alloc(0);
  return { pid: 4321, status: 0, signal: null, stdout, stderr, output: [null, stdout, stderr], ...overrides };
}

function alive(startTime = START, evidence: readonly ObservationFact[] = [probeOk]): ProcessObservation {
  return { kind: 'alive', pid: PID, startTime: makeProcessStartTime(startTime), evidence };
}

function unknownObservation(
  reason: Extract<ProcessObservation, { kind: 'unknown' }>['reason'],
  evidence: readonly ObservationFact[],
): ProcessObservation {
  return { kind: 'unknown', pid: PID, reason, evidence };
}

function query(raw: SpawnSyncReturns<Buffer>): ObservationFact {
  return { operation: 'start_time', outcome: 'result', raw };
}

function from(observation: ProcessObservation): ProcessStartTimeFact {
  return processStartTimeFactFromObservation(observation, AT_MS);
}

describe('ProcessStartTimeFact decoder', () => {
  it('decodes a valid C-locale lstart in the host zone with second precision and evidence', () => {
    const observation = alive();
    const fact = from(observation);
    expect(fact).toEqual({
      kind: 'available',
      pid: PID,
      startTime: makeProcessStartTime(START),
      startedAtMs: new Date(2026, 10, 10, 13, 27, 59, 0).getTime(),
      precision: 'second',
      evidence: { version: 1, atMs: AT_MS, facts: [expect.any(Object)] },
    });
    expect(JSON.stringify(fact.evidence)).toContain(START);
  });

  it.each([
    'Mon Nov 10 13:27:59 2026', // weekday does not match the calendar date
    'Tue Feb 31 13:27:59 2026',
    'Tue Nov 31 13:27:59 2026',
    'Tue Nov 10 25:27:59 2026',
    'Foo Nov 10 13:27:59 2026',
    'Tue Foo 10 13:27:59 2026',
    'not a date',
  ])('reports malformed for invalid lstart %s', startTime => {
    expect(from(alive(startTime))).toMatchObject({ kind: 'unavailable', reason: 'malformed' });
  });

  it('reports a malformed observation without flattening its evidence', () => {
    const raw = rawResult({ stdout: Buffer.from('not a date') });
    const observation = unknownObservation('malformed_start_time', [probeOk, query(raw), probeOk]);
    const fact = from(observation);
    expect(fact).toMatchObject({ kind: 'unavailable', pid: PID, reason: 'malformed' });
    expect(fact.evidence.atMs).toBe(AT_MS);
    expect(fact.evidence.facts).toHaveLength(1);
  });
});

describe('ProcessStartTimeFact unavailable mapping', () => {
  it('keeps invalid PID and unsupported platform distinct', () => {
    expect(from(unknownObservation('invalid_pid', []))).toMatchObject({ reason: 'invalid_pid' });
    expect(from(unknownObservation('unsupported_platform', []))).toMatchObject({ reason: 'unsupported_platform' });
  });

  it('keeps initial and final PID-gone observations as pid_gone with their original evidence', () => {
    const error = errno('ESRCH');
    const initial: ProcessObservation = {
      kind: 'gone', pid: PID,
      evidence: [{ operation: 'signal0', outcome: 'error', error }],
    };
    const final: ProcessObservation = {
      kind: 'gone', pid: PID,
      evidence: [probeOk, query(rawResult()), { operation: 'signal0', outcome: 'error', error }],
    };
    expect(from(initial)).toMatchObject({ kind: 'unavailable', reason: 'pid_gone' });
    expect(from(final)).toMatchObject({ kind: 'unavailable', reason: 'pid_gone' });
    expect(from(initial).evidence.facts).toHaveLength(1);
    expect(from(final).evidence.facts).toHaveLength(1);
  });

  it.each(['EPERM', 'EACCES'])('maps initial and final probe %s to permission_denied', code => {
    const failure: ObservationFact = { operation: 'signal0', outcome: 'error', error: errno(code) };
    expect(from(unknownObservation('probe_failed', [failure]))).toMatchObject({ reason: 'permission_denied' });
    expect(from(unknownObservation('probe_failed', [probeOk, query(rawResult()), failure])))
      .toMatchObject({ reason: 'permission_denied' });
  });

  it.each(['EPERM', 'EACCES'])('maps query %s to permission_denied', code => {
    const raw = rawResult({ error: errno(code), status: null });
    expect(from(unknownObservation('start_time_unavailable', [probeOk, query(raw), probeOk])))
      .toMatchObject({ reason: 'permission_denied' });
  });

  it.each([
    errno('ETIMEDOUT'),
    Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }),
    Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
  ])('maps query timeout or abort to timed_out', error => {
    const raw = rawResult({ error, status: null, signal: 'SIGKILL' });
    expect(from(unknownObservation('start_time_unavailable', [probeOk, query(raw), probeOk])))
      .toMatchObject({ reason: 'timed_out' });
  });

  it.each([
    ['nonzero exit', rawResult({ status: 2, stderr: Buffer.from('ps failed') })],
    ['missing ps', rawResult({ error: errno('ENOENT'), status: null })],
    ['output overflow', rawResult({ error: errno('ENOBUFS'), status: null })],
    ['generic probe failure', undefined],
  ])('maps %s to query_failed', (_name, raw) => {
    const observation = raw === undefined
      ? unknownObservation('probe_failed', [{ operation: 'signal0', outcome: 'error', error: errno('EIO') }])
      : unknownObservation('start_time_unavailable', [probeOk, query(raw), probeOk]);
    expect(from(observation)).toMatchObject({ kind: 'unavailable', reason: 'query_failed' });
  });

  it.each(['', '  \n'])('maps successful empty or whitespace-only stdout %j to empty', stdout => {
    const raw = rawResult({ stdout: Buffer.from(stdout) });
    expect(from(unknownObservation('start_time_unavailable', [probeOk, query(raw), probeOk])))
      .toMatchObject({ kind: 'unavailable', reason: 'empty' });
  });

  it('keeps thrown query failures and their safe encoded evidence', () => {
    const error = Object.assign(new Error('native failure'), { detail: Buffer.from('secret-free fixture') });
    const observation = unknownObservation('start_time_unavailable', [
      probeOk,
      { operation: 'start_time', outcome: 'throw', error },
      probeOk,
    ]);
    const fact = from(observation);
    expect(fact).toMatchObject({ kind: 'unavailable', reason: 'query_failed' });
    expect(JSON.stringify(fact.evidence)).toContain('native failure');
    expect(fact).not.toHaveProperty('error');
  });
});

describe('ProcessStartTimeFact public surface', () => {
  it('exports only the narrow fact capability, not raw observations', () => {
    const barrel = readFileSync(
      new URL('../../../src/foundation/process-exec/index.ts', import.meta.url),
      'utf8',
    );
    expect(barrel).toContain("export { observeProcessStartTime } from './process-starttime-fact.js';");
    expect(barrel).toContain('ProcessStartTimeFact');
    expect(barrel).toContain('ProcessStartTimeUnavailableReason');
    expect(barrel).not.toMatch(/export\s+type\s*\{[^}]*\b(?:ProcessObservation|ObservationFact)\b/);
    expect(barrel).not.toMatch(/export\s*\{[^}]*\bobserveProcess\b/);
  });
});
