import type { SpawnSyncReturns } from 'node:child_process';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureCurrentProcessRef,
  decodeProcessRef,
  inspectProcessRef,
  type ProcessRef,
} from '../../../src/foundation/process-exec/index.js';
import * as processObservation from '../../../src/foundation/process-exec/process-observation.js';
import type {
  ObservationFact,
  ProcessObservation,
} from '../../../src/foundation/process-exec/process-observation.js';
import type { ProcessStartTime } from '../../../src/foundation/process-exec/process-starttime.js';

const PID = 12345;
const HOST = os.hostname();
const START = 'Tue Nov 10 13:27:59 2026';
const OTHER_START = 'Tue Nov 10 13:28:00 2026';
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalTz = process.env.TZ;
const errno = (code: string) => Object.assign(new Error(`failure ${code}`), { code });
const probeOk: ObservationFact = { operation: 'signal0', outcome: 'ok' };

function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value });
}

function rawResult(
  start = START,
  overrides: Partial<SpawnSyncReturns<Buffer>> = {},
): SpawnSyncReturns<Buffer> {
  const stdout = Buffer.from(`${start}    \n`);
  const stderr = Buffer.alloc(0);
  return {
    pid: 4321, status: 0, signal: null, stdout, stderr,
    output: [null, stdout, stderr], ...overrides,
  };
}

function alive(start = START): ProcessObservation {
  return {
    kind: 'alive', pid: PID, startTime: start as ProcessStartTime,
    evidence: [probeOk, { operation: 'start_time', outcome: 'result', raw: rawResult(start) }, probeOk],
  };
}

function gone(evidence: readonly ObservationFact[] = [
  { operation: 'signal0', outcome: 'error', error: errno('ESRCH') },
]): ProcessObservation {
  return { kind: 'gone', pid: PID, evidence };
}

function unknown(
  reason: Extract<ProcessObservation, { kind: 'unknown' }>['reason'],
  evidence: readonly ObservationFact[],
): ProcessObservation {
  return { kind: 'unknown', pid: PID, reason, evidence };
}

function dateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  return { resolvedOptions: () => ({ timeZone }) } as Intl.DateTimeFormat;
}

function v1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    pid: PID,
    startTime: START,
    source: { platform: 'darwin', hostname: HOST, tzEnv: null, timeZone: 'UTC' },
    basis: 'posix-lstart-second',
    capturedAtMs: 1_794_883_200_000,
    ...overrides,
  };
}

function asRef(value: unknown): ProcessRef {
  return JSON.stringify(value) as ProcessRef;
}

function expectJsonRoundTrip<T>(value: T): void {
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
}

beforeEach(() => {
  platform('darwin');
  delete process.env.TZ;
  vi.spyOn(processObservation, 'observeProcess').mockReturnValue(alive());
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => dateTimeFormat('UTC'));
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('process reference decoding', () => {
  it('accepts strict v1 strings and legacy v0 strings/adapters without OS access', () => {
    const current = asRef(v1());
    expect(decodeProcessRef(current)).toEqual({ kind: 'decoded', value: current });
    const legacy = asRef({ version: 0, pid: PID, startTime: START });
    expect(decodeProcessRef(legacy)).toEqual({ kind: 'decoded', value: legacy });
    expect(decodeProcessRef({ version: 0, pid: PID, startTime: undefined })).toEqual({
      kind: 'decoded', value: asRef({ version: 0, pid: PID }),
    });
    expect(decodeProcessRef({ version: 0, pid: PID, startTime: 'legacy opaque text' }).kind)
      .toBe('decoded');
    expect(processObservation.observeProcess).not.toHaveBeenCalled();
    expect(Intl.DateTimeFormat).not.toHaveBeenCalled();
  });

  const invalid: unknown[] = [
    null, [], '{bad json', 'null', '[]', '{}',
    { version: 0, pid: 0 }, { version: 0, pid: -1 }, { version: 0, pid: 1.5 },
    { version: 0, pid: Number.MAX_SAFE_INTEGER + 1 },
    { version: 0, pid: PID, startTime: null },
    { version: 0, pid: PID, extra: true },
    asRef(v1({ pid: NaN })), asRef(v1({ startTime: 'not an lstart' })), asRef(v1({ source: null })),
    asRef(v1({ capturedAtMs: -1 })), asRef(v1({ capturedAtMs: Number.MAX_SAFE_INTEGER })),
    asRef(v1({ basis: 'other' })), asRef(v1({ extra: true })),
    asRef(v1({ source: { platform: 'darwin', hostname: HOST, tzEnv: null, timeZone: 'UTC', extra: 1 } })),
    asRef(v1({ source: { platform: 'win32', hostname: HOST, tzEnv: null, timeZone: 'UTC' } })),
  ];
  it.each(invalid)('rejects damaged input with encoded input evidence: %j', input => {
    const result = decodeProcessRef(input);
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') throw new Error('expected invalid decode');
    expect(result.reason.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.evidence)).not.toBe('{}');
    expectJsonRoundTrip(result);
    expect(processObservation.observeProcess).not.toHaveBeenCalled();
  });

  it('distinguishes future versions and rejects forged brands during inspect', () => {
    const future = decodeProcessRef(asRef(v1({ version: 2 })));
    expect(future.kind).toBe('unsupported_version');
    expectJsonRoundTrip(future);
    const inspectedFuture = inspectProcessRef(asRef(v1({ version: 2 })));
    expect(inspectedFuture).toMatchObject({ kind: 'unknown', reason: 'unsupported' });
    expectJsonRoundTrip(inspectedFuture);
    const inspectedInvalid = inspectProcessRef('{forged' as ProcessRef);
    expect(inspectedInvalid).toMatchObject({ kind: 'unknown', reason: 'identity_unverifiable' });
    expect(JSON.stringify(inspectedInvalid.evidence)).toContain('malformed_json');
    expectJsonRoundTrip(inspectedInvalid);
    expect(processObservation.observeProcess).not.toHaveBeenCalled();
    expect(Intl.DateTimeFormat).not.toHaveBeenCalled();
  });
});

describe('v1 process reference observation', () => {
  it('returns alive only for matching source, complete observation, and start time', () => {
    const result = inspectProcessRef(asRef(v1()));
    expect(result.kind).toBe('alive');
    expectJsonRoundTrip(result);
    expect(processObservation.observeProcess).toHaveBeenCalledExactlyOnceWith(PID);
    expect(Intl.DateTimeFormat).toHaveBeenCalledTimes(2);
  });

  it('returns gone/absent for ESRCH after consistent source reads', () => {
    vi.mocked(processObservation.observeProcess).mockReturnValue(gone());
    const result = inspectProcessRef(asRef(v1()));
    expect(result).toMatchObject({ kind: 'gone', reason: 'absent' });
    expectJsonRoundTrip(result);
  });

  it('returns gone/identity_changed for a different complete start time', () => {
    vi.mocked(processObservation.observeProcess).mockReturnValue(alive(OTHER_START));
    const result = inspectProcessRef(asRef(v1()));
    expect(result).toMatchObject({ kind: 'gone', reason: 'identity_changed' });
    expectJsonRoundTrip(result);
  });

  it('maps permission, ps failure, timeout, and malformed output without dropping evidence', () => {
    vi.mocked(processObservation.observeProcess).mockReturnValue(unknown('probe_failed', [
      { operation: 'signal0', outcome: 'error', error: errno('EPERM') },
    ]));
    expect(inspectProcessRef(asRef(v1()))).toMatchObject({ kind: 'unknown', reason: 'permission_denied' });

    const rawFailure = rawResult(START, {
      status: 2, stdout: Buffer.alloc(0), stderr: Buffer.from('ps failed'),
    });
    vi.mocked(processObservation.observeProcess).mockReturnValue(unknown('start_time_unavailable', [
      probeOk, { operation: 'start_time', outcome: 'result', raw: rawFailure }, probeOk,
    ]));
    const failed = inspectProcessRef(asRef(v1()));
    expect(failed).toMatchObject({ kind: 'unknown', reason: 'query_failed' });
    expect(JSON.stringify(failed.evidence)).toContain('cHMgZmFpbGVk');
    expectJsonRoundTrip(failed);

    const timeout = rawResult(START, {
      error: errno('ETIMEDOUT'), status: null, signal: 'SIGKILL',
    });
    vi.mocked(processObservation.observeProcess).mockReturnValue(unknown('start_time_unavailable', [
      probeOk, { operation: 'start_time', outcome: 'result', raw: timeout }, probeOk,
    ]));
    expect(inspectProcessRef(asRef(v1()))).toMatchObject({ kind: 'unknown', reason: 'timed_out' });

    vi.mocked(processObservation.observeProcess).mockReturnValue(unknown('malformed_start_time', [
      probeOk, { operation: 'start_time', outcome: 'result', raw: rawResult('not a date') }, probeOk,
    ]));
    expect(inspectProcessRef(asRef(v1()))).toMatchObject({ kind: 'unknown', reason: 'incomplete_data' });
  });

  it('retains an earlier query failure when the later probe fails or proves absence', () => {
    const raw = rawResult(START, {
      error: errno('ENOBUFS'), stdout: Buffer.from('partial'), stderr: Buffer.from('diagnostic'),
    });
    const query: ObservationFact = { operation: 'start_time', outcome: 'result', raw };
    vi.mocked(processObservation.observeProcess).mockReturnValue(unknown('probe_failed', [
      probeOk, query, { operation: 'signal0', outcome: 'error', error: errno('EPERM') },
    ]));
    const indeterminate = inspectProcessRef(asRef(v1()));
    expect(indeterminate).toMatchObject({ kind: 'unknown', reason: 'permission_denied' });
    expect(JSON.stringify(indeterminate.evidence)).toContain('ENOBUFS');
    expect(JSON.stringify(indeterminate.evidence)).toContain('EPERM');

    vi.mocked(processObservation.observeProcess).mockReturnValue(gone([
      probeOk, query, { operation: 'signal0', outcome: 'error', error: errno('ESRCH') },
    ]));
    const absent = inspectProcessRef(asRef(v1()));
    expect(absent).toMatchObject({ kind: 'gone', reason: 'absent' });
    expect(JSON.stringify(absent.evidence)).toContain('ENOBUFS');
    expectJsonRoundTrip(absent);
  });
});

describe('current process capture and source safety', () => {
  it('captures a strict v1 reference only after matching before/after contexts', () => {
    const result = captureCurrentProcessRef();
    expect(result.kind).toBe('captured');
    if (result.kind !== 'captured') throw new Error(JSON.stringify(result));
    const decoded = decodeProcessRef(result.value);
    expect(decoded).toEqual({ kind: 'decoded', value: result.value });
    expect(JSON.parse(result.value)).toMatchObject({
      version: 1,
      pid: process.pid,
      startTime: START,
      source: { platform: 'darwin', hostname: HOST, tzEnv: null, timeZone: 'UTC' },
      basis: 'posix-lstart-second',
    });
    expect(Intl.DateTimeFormat).toHaveBeenCalledTimes(2);
    expectJsonRoundTrip(result);
  });

  it('reports capture-time exit as gone and retains query order', () => {
    vi.mocked(processObservation.observeProcess).mockReturnValue(gone());
    const result = captureCurrentProcessRef();
    expect(result.kind).toBe('gone');
    expect(Intl.DateTimeFormat).toHaveBeenCalledTimes(2);
    expectJsonRoundTrip(result);
  });

  it('does not turn a capture-time exit into gone when the later context differs', () => {
    vi.mocked(processObservation.observeProcess).mockReturnValue(gone());
    vi.mocked(Intl.DateTimeFormat).mockReset()
      .mockImplementationOnce(() => dateTimeFormat('UTC'))
      .mockImplementationOnce(() => { throw errno('EIO'); });
    const result = captureCurrentProcessRef();
    expect(result).toMatchObject({ kind: 'unknown', reason: 'identity_unverifiable' });
    expectJsonRoundTrip(result);
  });

  it('does not query when the initial context cannot be read', () => {
    vi.mocked(Intl.DateTimeFormat).mockImplementation(() => { throw errno('EIO'); });
    const capture = captureCurrentProcessRef();
    expect(capture).toMatchObject({ kind: 'unknown', reason: 'identity_unverifiable' });
    const inspected = inspectProcessRef(asRef(v1()));
    expect(inspected).toMatchObject({ kind: 'unknown', reason: 'identity_unverifiable' });
    expect(processObservation.observeProcess).not.toHaveBeenCalled();
    expectJsonRoundTrip(capture);
    expectJsonRoundTrip(inspected);
  });

  it('keeps changing contexts unknown even when the OS observation is alive', () => {
    vi.mocked(Intl.DateTimeFormat).mockReset()
      .mockImplementationOnce(() => dateTimeFormat('UTC'))
      .mockImplementationOnce(() => dateTimeFormat('Asia/Shanghai'));
    const capture = captureCurrentProcessRef();
    expect(capture).toMatchObject({ kind: 'unknown', reason: 'identity_unverifiable' });
    expectJsonRoundTrip(capture);

    vi.mocked(processObservation.observeProcess).mockClear();
    vi.mocked(Intl.DateTimeFormat).mockReset()
      .mockImplementationOnce(() => dateTimeFormat('UTC'))
      .mockImplementationOnce(() => dateTimeFormat('Asia/Shanghai'));
    const inspected = inspectProcessRef(asRef(v1()));
    expect(inspected).toMatchObject({ kind: 'unknown', reason: 'identity_unverifiable' });
    expect(processObservation.observeProcess).toHaveBeenCalledTimes(1);
    expectJsonRoundTrip(inspected);
  });

  it('never turns a foreign-source local ESRCH into gone', () => {
    vi.mocked(processObservation.observeProcess).mockReturnValue(gone());
    const foreign = v1({
      source: { platform: 'darwin', hostname: 'another-host', tzEnv: null, timeZone: 'UTC' },
    });
    const result = inspectProcessRef(asRef(foreign));
    expect(result).toMatchObject({ kind: 'unknown', reason: 'identity_unverifiable' });
    expect(processObservation.observeProcess).not.toHaveBeenCalled();
    expectJsonRoundTrip(result);
  });

  it('reports unsupported capture hosts without treating their data as v1', () => {
    platform('win32');
    vi.mocked(processObservation.observeProcess).mockReturnValue(
      unknown('unsupported_platform', []),
    );
    const result = captureCurrentProcessRef();
    expect(result).toMatchObject({ kind: 'unknown', reason: 'unsupported' });
    expectJsonRoundTrip(result);
  });
});

describe('legacy v0 process reference observation', () => {
  it('retains the narrow same-host absence recovery', () => {
    vi.mocked(processObservation.observeProcess).mockReturnValue(gone());
    const result = inspectProcessRef(asRef({ version: 0, pid: PID, startTime: START }));
    expect(result).toMatchObject({ kind: 'gone', reason: 'absent' });
    expect(JSON.stringify(result.evidence)).toContain('legacy-v0');
    expect(JSON.stringify(result.evidence)).toContain('same-host-configuration-directory-only');
    expect(Intl.DateTimeFormat).not.toHaveBeenCalled();
    expectJsonRoundTrip(result);
  });

  it.each([
    { version: 0, pid: PID },
    { version: 0, pid: PID, startTime: START },
    { version: 0, pid: PID, startTime: OTHER_START },
  ])('keeps every existing legacy PID unknown regardless of timestamp: %j', legacy => {
    vi.mocked(processObservation.observeProcess).mockReturnValue(alive(OTHER_START));
    const result = inspectProcessRef(asRef(legacy));
    expect(result).toMatchObject({ kind: 'unknown', reason: 'identity_unverifiable' });
    expect(JSON.stringify(result.evidence)).toContain(OTHER_START);
    expectJsonRoundTrip(result);
  });

  it('keeps legacy query failures distinct from identity-unverifiable presence', () => {
    vi.mocked(processObservation.observeProcess).mockReturnValue(unknown('probe_failed', [
      { operation: 'signal0', outcome: 'error', error: errno('EACCES') },
    ]));
    const result = inspectProcessRef(asRef({ version: 0, pid: PID }));
    expect(result).toMatchObject({ kind: 'unknown', reason: 'permission_denied' });
    expectJsonRoundTrip(result);
  });
});
