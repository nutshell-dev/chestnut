import { describe, expect, it, vi } from 'vitest';
import {
  captureCurrentProcessIdentity,
  observeProcessTarget,
  terminateMatchingProcesses,
  terminateProcessTarget,
  type ProcessEvidence,
  type ProcessTargetObservation,
} from '../../../src/foundation/process-exec/index.js';
import { makeProcessStartTime } from '../../../src/foundation/process-exec/process-starttime.js';
import type { ProcessObservation } from '../../../src/foundation/process-exec/process-observation.js';

const PID = 12345;
const START = makeProcessStartTime('Tue Nov 10 13:27:59 2026');
const OTHER_START = makeProcessStartTime('Tue Nov 10 13:28:00 2026');
const evidence = (): ProcessEvidence => ({ version: 1, atMs: 0, facts: [] });
const observation = (kind: 'alive' | 'gone' | 'unknown'): ProcessTargetObservation =>
  kind === 'alive'
    ? { kind, evidence: evidence() }
    : kind === 'gone'
      ? { kind, reason: 'absent', evidence: evidence() }
      : { kind, reason: 'query_failed', evidence: evidence() };
const rawAlive = (startTime = START): ProcessObservation => ({
  kind: 'alive', pid: PID, startTime, evidence: [],
});

describe('typed process target observation', () => {
  it('keeps start-time matching and PID reuse in L1', () => {
    expect(observeProcessTarget({ pid: PID, startTime: START }, { observe: () => rawAlive() }).kind)
      .toBe('alive');
    expect(observeProcessTarget(
      { pid: PID, startTime: START },
      { observe: () => rawAlive(OTHER_START) },
    )).toMatchObject({ kind: 'gone', reason: 'identity_changed' });
  });

  it('preserves permission failure as unknown instead of boolean false', () => {
    const permission = Object.assign(new Error('denied'), { code: 'EPERM' });
    const raw: ProcessObservation = {
      kind: 'unknown', pid: PID, reason: 'probe_failed',
      evidence: [{ operation: 'signal0', outcome: 'error', error: permission }],
    };
    const result = observeProcessTarget({ pid: PID }, { observe: () => raw });
    expect(result).toMatchObject({ kind: 'unknown', reason: 'permission_denied' });
    expect(JSON.stringify(result.evidence)).toContain('EPERM');
  });

  it('adapts legacy ESRCH and EPERM without losing the original error', () => {
    const gone = Object.assign(new Error('gone'), { code: 'ESRCH' });
    expect(observeProcessTarget({ pid: PID }, {
      legacyProbe: () => { throw gone; },
    })).toMatchObject({ kind: 'gone', reason: 'absent' });
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    const result = observeProcessTarget({ pid: PID }, {
      legacyProbe: () => { throw denied; },
    });
    expect(result).toMatchObject({ kind: 'unknown', error: denied });
  });

  it('keeps argv identity and argv permission failures distinct', () => {
    expect(observeProcessTarget(
      { pid: PID, argvToken: 'watchdog-entry' },
      { legacyProbe: () => true, argvMatch: () => false },
    )).toMatchObject({ kind: 'gone', reason: 'identity_changed' });

    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    const result = observeProcessTarget(
      { pid: PID, argvToken: 'watchdog-entry' },
      { legacyProbe: () => true, argvMatch: () => { throw denied; } },
    );
    expect(result).toMatchObject({ kind: 'unknown', reason: 'permission_denied', error: denied });
    expect(JSON.stringify(result.evidence)).toContain('legacy_argv_probe');
  });
});

describe('current process identity capture', () => {
  it('captures the current PID and observed start time without legacy adapters', () => {
    const result = captureCurrentProcessIdentity(() => rawAlive());
    expect(result).toMatchObject({
      kind: 'captured',
      target: { pid: process.pid, startTime: START },
    });
    expect(JSON.stringify(result.evidence)).toContain('Tue Nov 10 13:27:59 2026');
  });

  it('keeps unknown identity and raw permission evidence instead of inventing a start time', () => {
    const permission = Object.assign(new Error('denied'), { code: 'EPERM' });
    const result = captureCurrentProcessIdentity(() => ({
      kind: 'unknown', pid: process.pid, reason: 'probe_failed',
      evidence: [{ operation: 'signal0', outcome: 'error', error: permission }],
    }));

    expect(result).toMatchObject({ kind: 'unknown', reason: 'permission_denied' });
    expect(result).not.toHaveProperty('target');
    expect(JSON.stringify(result.evidence)).toContain('EPERM');
  });

  it('distinguishes a gone process and preserves observation adapter failures', () => {
    expect(captureCurrentProcessIdentity(() => ({
      kind: 'gone', pid: process.pid, evidence: [],
    }))).toMatchObject({ kind: 'gone' });

    const failure = new Error('observation failed');
    const result = captureCurrentProcessIdentity(() => { throw failure; });
    expect(result).toMatchObject({ kind: 'unknown', reason: 'query_failed', error: failure });
    expect(JSON.stringify(result.evidence)).toContain('observation failed');
  });
});

describe('typed process termination', () => {
  const immediate = { graceMs: 0, confirmMs: 0, pollIntervalMs: 1 };

  it('owns TERM and settle confirmation', async () => {
    let alive = true;
    const signal = vi.fn(() => { alive = false; });
    const result = await terminateProcessTarget({ pid: PID }, immediate, {
      signal,
      observeTarget: () => observation(alive ? 'alive' : 'gone'),
    });
    expect(result).toMatchObject({ kind: 'gone', via: 'sigterm', termSent: true, killSent: false });
    expect(signal).toHaveBeenCalledExactlyOnceWith(PID, 'TERM');
  });

  it('escalates to KILL and reports a survivor without claiming gone', async () => {
    const signal = vi.fn();
    const result = await terminateProcessTarget({ pid: PID }, immediate, {
      signal,
      observeTarget: () => observation('alive'),
    });
    expect(result).toMatchObject({ kind: 'still_alive', termSent: true, killSent: true });
    expect(signal).toHaveBeenNthCalledWith(1, PID, 'TERM');
    expect(signal).toHaveBeenNthCalledWith(2, PID, 'KILL');
  });

  it('does not signal an unknown identity', async () => {
    const signal = vi.fn();
    const result = await terminateProcessTarget({ pid: PID }, immediate, {
      signal,
      observeTarget: () => observation('unknown'),
    });
    expect(result).toMatchObject({ kind: 'indeterminate', stage: 'observe' });
    expect(signal).not.toHaveBeenCalled();
  });

  it('retains signal failure evidence', async () => {
    const failure = Object.assign(new Error('denied'), { code: 'EPERM' });
    const result = await terminateProcessTarget({ pid: PID }, immediate, {
      signal: () => { throw failure; },
      observeTarget: () => observation('alive'),
    });
    expect(result).toMatchObject({ kind: 'indeterminate', stage: 'sigterm', error: failure });
  });

  it('does not signal a reused argv identity even with a legacy probe', async () => {
    const signal = vi.fn();
    const result = await terminateProcessTarget(
      { pid: PID, argvToken: 'watchdog-entry' },
      immediate,
      { signal, legacyProbe: () => true, argvMatch: () => false },
    );
    expect(result).toMatchObject({ kind: 'gone', via: 'already_gone', termSent: false });
    expect(signal).not.toHaveBeenCalled();
  });
});

describe('typed matching-process cleanup', () => {
  it('filters sibling tokens and accepts PID reuse with different argv', async () => {
    const signal = vi.fn();
    let listing = 0;
    const result = await terminateMatchingProcesses({
      pattern: 'daemon',
      requiredArgvToken: '/claws/a',
      graceMs: 0,
      signal,
      list: () => {
        listing++;
        return listing === 1
          ? [
              { pid: 41, command: 'node daemon /claws/a' },
              { pid: 42, command: 'node daemon /claws/a-sibling' },
            ]
          : [{ pid: 41, command: 'node other /claws/other' }];
      },
    });
    expect(result).toMatchObject({ kind: 'clear', terminated: 1, skipped: [42] });
    expect(signal).toHaveBeenCalledExactlyOnceWith(41, 'TERM');
  });

  it('blocks when argv evidence is unavailable instead of skipping a candidate', async () => {
    const signal = vi.fn();
    const result = await terminateMatchingProcesses({
      pattern: 'daemon', requiredArgvToken: '/claws/a', graceMs: 0, signal,
      list: () => [{ pid: 41, command: '' }],
    });
    expect(result).toMatchObject({ kind: 'blocked', stage: 'enumerate', pids: [41] });
    expect(signal).not.toHaveBeenCalled();
  });
});
