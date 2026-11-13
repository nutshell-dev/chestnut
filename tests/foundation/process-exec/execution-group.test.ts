import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminateExecutionGroup } from '../../../src/foundation/process-exec/execution-group.js';

describe('terminateExecutionGroup signal failure convergence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('confirms group gone after SIGKILL EPERM instead of returning indeterminate immediately', async () => {
    const identity = { leaderPid: 424_242, processGroupId: 424_242 };
    let zeroSignalCount = 0;

    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-identity.processGroupId);
      if (signal === 'SIGTERM') return true;
      if (signal === 'SIGKILL') {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
      if (signal === 0) {
        zeroSignalCount += 1;
        if (zeroSignalCount === 1) return true;
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      throw new Error(`unexpected signal: ${String(signal)}`);
    });

    const outcome = await terminateExecutionGroup(identity, 'timeout', {
      graceMs: 0,
      confirmMs: 0,
    });

    expect(outcome).toMatchObject({
      status: 'gone',
      trigger: 'timeout',
      termSent: true,
      killSent: false,
      identity,
    });
    expect(zeroSignalCount).toBe(2);
  });

  it('keeps sigkill_send_failed when the group still responds through the confirmation budget', async () => {
    const identity = { leaderPid: 424_243, processGroupId: 424_243 };
    let zeroSignalCount = 0;

    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-identity.processGroupId);
      if (signal === 'SIGTERM') return true;
      if (signal === 'SIGKILL') {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
      if (signal === 0) {
        zeroSignalCount += 1;
        return true;
      }
      throw new Error(`unexpected signal: ${String(signal)}`);
    });

    const outcome = await terminateExecutionGroup(identity, 'timeout', {
      graceMs: 0,
      confirmMs: 0,
    });

    expect(outcome).toMatchObject({
      status: 'indeterminate',
      trigger: 'timeout',
      termSent: true,
      killSent: false,
      identity,
      reason: 'sigkill_send_failed',
    });
    expect(zeroSignalCount).toBe(2);
  });
});


describe('typed termination evidence and unknown observations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not escalate to SIGKILL when the post-TERM observation is unknown', async () => {
    const identity = { leaderPid: 424_244, processGroupId: 424_244 };
    const signals: Array<string | number | NodeJS.Signals | null> = [];
    const permissionError = Object.assign(new Error('probe EPERM'), { code: 'EPERM' });

    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-identity.processGroupId);
      signals.push(signal ?? null);
      if (signal === 'SIGTERM') return true;
      if (signal === 0) throw permissionError;
      throw new Error(`unexpected signal: ${String(signal)}`);
    });

    const outcome = await terminateExecutionGroup(identity, 'caller_requested', {
      graceMs: 0,
      confirmMs: 0,
    });

    expect(outcome).toMatchObject({
      status: 'indeterminate',
      reason: 'group_probe_failed',
      termSent: true,
      killSent: false,
    });
    expect(signals).toEqual(['SIGTERM', 0]);
    expect(JSON.stringify(outcome.evidence)).toContain('EPERM');
  });
});
