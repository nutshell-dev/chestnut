import { describe, it, expect, vi } from 'vitest';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { CronRunner, type CronJob } from '../../../src/core/cron/runner.js';

// mock helper (mirror runner-stop-drain.test.ts)
function makeMockAudit(): { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() };
}

describe('phase 946: cron handler AbortSignal propagation', () => {
  it('stop() abort signal → handler signal.aborted = true', async () => {
    const observed: { aborted: boolean | null } = { aborted: null };
    const handlerPromise = new Promise<void>(resolve => {
      setTimeout(resolve, 5000); // long handler
    });

    const job: CronJob = {
      name: 'test-abort',
      enabled: true,
      schedule: { type: 'interval', minutes: 1 },
      handler: async (signal) => {
        observed.aborted = signal?.aborted ?? null;
        signal?.addEventListener('abort', () => {
          observed.aborted = true;
        });
        await handlerPromise;
      },
    };

    const audit = makeMockAudit();
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.start(10);

    // 等 handler 起跑
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(observed.aborted).toBe(false);

    // stop → abort signal 应触发
    await runner.stop(100);  // cap 100ms 强制 drain timeout
    expect(observed.aborted).toBe(true);
  });

  it('stop() drain 实际 < cap timeout（signal aborted → handler early settle）', async () => {
    // mock handler that respects signal early abort
    const job: CronJob = {
      name: 'test-early',
      enabled: true,
      schedule: { type: 'interval', minutes: 1 },
      handler: async (signal) => {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(resolve, 30_000);  // would block 30s
        });
      },
    };
    const audit = makeMockAudit();
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.start(10);
    await new Promise(resolve => setTimeout(resolve, 50));
    const start = Date.now();
    await runner.stop(30_000);  // cap 30s
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);  // early abort < 1s
  });

  it('backward compat: handler 不接 signal 0 break', async () => {
    let ran = false;
    const job: CronJob = {
      name: 'test-legacy',
      enabled: true,
      schedule: { type: 'interval', minutes: 1 },
      handler: async () => { ran = true; },  // 不接 signal
    };
    const audit = makeMockAudit();
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.start(10);
    await new Promise(resolve => setTimeout(resolve, 50));
    await runner.stop(100);
    expect(ran).toBe(true);
  });
});
