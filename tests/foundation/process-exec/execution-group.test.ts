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
