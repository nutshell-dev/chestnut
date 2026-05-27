import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import { CronRunner } from '../../../src/core/cron/runner.js';

// mock helper (mirror runner-stop-drain.test.ts)
function makeMockAudit(): { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() };
}

describe('CronRunner.stop drain late-settle audit (phase 867)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it('emits RUNNER_DRAIN_LATE_SETTLE settled when stuck handler eventually resolves', async () => {
    let resolveHandler!: () => void;
    const handlerPromise = new Promise<void>(resolve => { resolveHandler = resolve; });

    const audit = makeMockAudit();
    const runner = new CronRunner([{
      name: 'stuck-job',
      enabled: true,
      schedule: { type: 'interval', minutes: 1 },
      handler: () => handlerPromise,
    }], audit as unknown as AuditLog);

    runner.start();
    runner.tick();

    // Stop with 100ms drain cap
    const stopPromise = runner.stop(100);
    // Drain timeout fires
    await vi.advanceTimersByTimeAsync(100);
    await stopPromise;

    // Verify RUNNER_DRAIN_TIMEOUT was emitted
    const calls = (audit.write as any).mock.calls;
    const timeoutCalls = calls.filter((c: any) => c[0] === CRON_AUDIT_EVENTS.RUNNER_DRAIN_TIMEOUT);
    expect(timeoutCalls.length).toBe(1);

    // Now resolve the handler (post-drain)
    resolveHandler();
    await vi.runAllTimersAsync();

    // Verify RUNNER_DRAIN_LATE_SETTLE settled audit emitted
    const lateSettleCalls = calls.filter(
      (c: any) => c[0] === CRON_AUDIT_EVENTS.RUNNER_DRAIN_LATE_SETTLE
    );
    expect(lateSettleCalls.length).toBe(1);
    expect(lateSettleCalls[0]).toContain('outcome=settled');
  });

  it('emits RUNNER_DRAIN_LATE_SETTLE err when stuck handler eventually rejects', async () => {
    let rejectHandler!: (err: Error) => void;
    const handlerPromise = new Promise<void>((_, reject) => { rejectHandler = reject; });

    const audit = makeMockAudit();
    const runner = new CronRunner([{
      name: 'stuck-error-job',
      enabled: true,
      schedule: { type: 'interval', minutes: 1 },
      handler: () => handlerPromise,
    }], audit as unknown as AuditLog);

    runner.start();
    runner.tick();

    const stopPromise = runner.stop(100);
    await vi.advanceTimersByTimeAsync(100);
    await stopPromise;

    rejectHandler(new Error('late fail'));
    await vi.runAllTimersAsync();

    const lateSettleCalls = (audit.write as any).mock.calls.filter(
      (c: any) => c[0] === CRON_AUDIT_EVENTS.RUNNER_DRAIN_LATE_SETTLE
    );
    expect(lateSettleCalls.length).toBe(1);
    expect(lateSettleCalls[0]).toContain('outcome=err');
    expect(lateSettleCalls[0]).toContain('error=late fail');
  });
});
