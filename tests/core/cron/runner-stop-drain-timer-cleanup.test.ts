import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import { CronRunner } from '../../../src/core/cron/runner.js';

// mock helper (mirror runner-stop-drain.test.ts)
function makeMockAudit(): { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() };
}

describe('CronRunner.stop() drain timer cleanup (phase 872 / new.P1.1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drain-success path clears setTimeout handle (no leak)', async () => {
    const audit = makeMockAudit();
    const runner = new CronRunner([{
      name: 'quick',
      enabled: true,
      schedule: { type: 'interval', minutes: 1 },
      handler: () => Promise.resolve(),
    }], audit as unknown as AuditLog);

    runner.start();
    runner.tick();
    // Let handler settle immediately (drainPromise needs inflightPromise to settle)
    await Promise.resolve();
    await Promise.resolve();

    const stopPromise = runner.stop(30_000);
    await vi.advanceTimersByTimeAsync(0); // drainPromise settles
    await stopPromise;

    // Verify: no active timers remain (drain timer cleared)
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drain-timeout path still emits audit + clears timer', async () => {
    const hangingHandler = () => new Promise<void>(() => { /* never resolve */ });

    const audit = makeMockAudit();
    const runner = new CronRunner([{
      name: 'hang',
      enabled: true,
      schedule: { type: 'interval', minutes: 1 },
      handler: hangingHandler,
    }], audit as unknown as AuditLog);

    runner.start();
    runner.tick();

    const stopPromise = runner.stop(100);
    await vi.advanceTimersByTimeAsync(100);
    await stopPromise;

    // Verify RUNNER_DRAIN_TIMEOUT audit was emitted
    const calls = (audit.write as any).mock.calls;
    const timeoutCalls = calls.filter((c: any) => c[0] === CRON_AUDIT_EVENTS.RUNNER_DRAIN_TIMEOUT);
    expect(timeoutCalls.length).toBe(1);

    // Verify: timer cleared after timeout path
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no inflight handlers — drain block skipped, no timer created', async () => {
    const audit = makeMockAudit();
    const runner = new CronRunner([{
      name: 'idle',
      enabled: true,
      schedule: { type: 'interval', minutes: 1 },
      handler: () => Promise.resolve(),
    }], audit as unknown as AuditLog);

    // Never tick = no inflight handlers
    await runner.stop(30_000);

    // Verify: no timers were ever created in drain block
    expect(vi.getTimerCount()).toBe(0);
  });
});
