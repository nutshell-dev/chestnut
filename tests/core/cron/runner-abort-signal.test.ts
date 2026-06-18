import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { CRON_TICK_INTERVAL_MS } from '../../../src/core/cron/constants.js';
import { CronRunner, type CronJob } from '../../../src/core/cron/runner.js';

// mock helper (mirror runner-stop-drain.test.ts)
function makeMockAudit(): { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() };
}

describe('phase 946: cron handler AbortSignal propagation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 5, 25, 10, 0, 0) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stop() abort signal → handler signal.aborted = true', async () => {
    const observed: { aborted: boolean | null } = { aborted: null };
    let handlerPromiseResolve: (() => void) | undefined;
    const handlerPromise = new Promise<void>(resolve => {
      handlerPromiseResolve = resolve;
    });
    // phase 373: handler 内 set 完 observed 后立 resolve、替原 vi.waitFor polling
    let handlerInvokedResolve!: () => void;
    const handlerInvoked = new Promise<void>((r) => { handlerInvokedResolve = r; });

    const job: CronJob = {
      name: 'test-abort',
      enabled: true,
      schedule: { type: 'hourly' },
      handler: async (signal) => {
        observed.aborted = signal?.aborted ?? null;
        signal?.addEventListener('abort', () => {
          observed.aborted = true;
        });
        handlerInvokedResolve();
        await handlerPromise;
      },
    };

    const audit = makeMockAudit();
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.start(10);

    // advance timers to fire tick → handler start
    await vi.advanceTimersByTimeAsync(50);

    await handlerInvoked;
    expect(observed.aborted).toBe(false);

    // stop → abort signal 应触发
    const stopPromise = runner.stop(100);  // cap 100ms
    await vi.advanceTimersByTimeAsync(150); // advance past cap
    handlerPromiseResolve!(); // unblock handler
    await stopPromise;
    expect(observed.aborted).toBe(true);
  });

  it('stop() drain 实际 < cap timeout（signal aborted → handler early settle）', async () => {
    // mock handler that respects signal early abort
    let started = false;
    // phase 373: handler 内 set started 后立 resolve、替原 vi.waitFor polling
    let startedResolve!: () => void;
    const startedP = new Promise<void>((r) => { startedResolve = r; });
    const job: CronJob = {
      name: 'test-early',
      enabled: true,
      schedule: { type: 'hourly' },
      handler: async (signal) => {
        started = true;
        startedResolve();
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(resolve, 30_000);  // would block 30s
        });
      },
    };
    const audit = makeMockAudit();
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.start(10);

    await vi.advanceTimersByTimeAsync(50);
    await startedP;

    // 用 fake elapsed（advance 累计）替 wall-clock Date.now() 计算
    const startFakeMs = vi.getMockedSystemTime()?.getTime() ?? 0;
    await runner.stop(30_000);  // cap 30s
    const endFakeMs = vi.getMockedSystemTime()?.getTime() ?? 0;
    const fakeElapsed = endFakeMs - startFakeMs;

    expect(fakeElapsed).toBeLessThan(CRON_TICK_INTERVAL_MS);  // early abort < 1 cron tick
  });

  it('backward compat: handler 不接 signal 0 break', async () => {
    let ran = false;
    // phase 373: handler 内 set ran 后立 resolve、替原 vi.waitFor polling
    let ranResolve!: () => void;
    const ranP = new Promise<void>((r) => { ranResolve = r; });
    const job: CronJob = {
      name: 'test-legacy',
      enabled: true,
      schedule: { type: 'hourly' },
      handler: async () => {
        ran = true;
        ranResolve();
      },
    };
    const audit = makeMockAudit();
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.start(10);

    await vi.advanceTimersByTimeAsync(50);
    await ranP;
    await runner.stop(100);
    expect(ran).toBe(true);
  });
});
