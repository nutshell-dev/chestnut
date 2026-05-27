/**
 * Phase 1232 r132 C: per-job AbortController + 真 abort verify
 *
 * 反向证明：
 *   1. timeout 触发后 controller.abort() 真 fire (signal.aborted === true)
 *   2. stuck watchdog 路径再次 abort idempotent + cleanup controller map
 *   3. late settle 后 controller map 清干净 (no leak)
 *   4. normal complete 后 controller map 也清干净
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronRunner, type CronJob } from '../../../src/core/cron/runner.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';

function makeMockAudit() {
  const events: Array<[string, ...string[]]> = [];
  return {
    write: vi.fn((type: string, ...cols: string[]) => events.push([type, ...cols])),
    events,
  };
}

describe('cron handler real abort (phase 1232 r132 C)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 5, 25, 10, 0, 0) });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 反向 1: timeout 后 signal.aborted === true + audit HANDLER_ABORTED context=timeout
  it('timeout 路径真 abort signal + audit HANDLER_ABORTED context=timeout', async () => {
    const audit = makeMockAudit();
    let capturedSignal: AbortSignal | undefined;
    const job: CronJob = {
      name: 'slow-job',
      enabled: true,
      schedule: { type: 'hourly' },
      timeoutMs: 50,
      handler: async (signal?: AbortSignal) => {
        capturedSignal = signal;
        await new Promise(r => setTimeout(r, 500));  // 超 timeoutMs
      },
    };
    const runner = new CronRunner([job], audit as any);
    runner.tick();
    await vi.advanceTimersByTimeAsync(100);  // 等 timeout fire
    expect(capturedSignal?.aborted).toBe(true);
    expect(
      audit.events.find(
        e => e[0] === CRON_AUDIT_EVENTS.HANDLER_ABORTED && e.some(c => c.includes('context=timeout'))
      )
    ).toBeDefined();
    runner.stop();
  });

  // 反向 2: stuck watchdog 路径再次 abort idempotent + 清 controller map
  it('stuck watchdog 路径 idempotent abort + controller cleanup', async () => {
    const audit = makeMockAudit();
    const job: CronJob = {
      name: 'stuck-job',
      enabled: true,
      schedule: { type: 'hourly' },
      timeoutMs: 10,
      handler: async () => new Promise(() => {}),  // 永不 settle
    };
    const runner = new CronRunner([job], audit as any);
    runner.tick();
    // 等 timeout fire
    await vi.advanceTimersByTimeAsync(100);
    // 模拟 10+ ticks stuck 后 watchdog
    for (let i = 0; i < 12; i++) runner.tick();
    const stuckEvents = audit.events.filter(
      e => e[0] === CRON_AUDIT_EVENTS.HANDLER_ABORTED && e.some(c => c.includes('context=stuck_watchdog'))
    );
    expect(stuckEvents.length).toBeGreaterThan(0);
    // controller map should be cleaned
    expect((runner as any)._activeAbortControllers.has('stuck-job')).toBe(false);
    runner.stop();
  });

  // 反向 3: late settle 后 controller map 清干净
  it('late settle 路径 controller cleanup (no leak)', async () => {
    const audit = makeMockAudit();
    let resolveHandler: () => void = () => {};
    const job: CronJob = {
      name: 'late-job',
      enabled: true,
      schedule: { type: 'hourly' },
      timeoutMs: 10,
      handler: () => new Promise<void>(r => { resolveHandler = r; }),
    };
    const runner = new CronRunner([job], audit as any);
    runner.tick();
    await vi.advanceTimersByTimeAsync(100);  // timeout fire
    resolveHandler();  // late settle
    await vi.advanceTimersByTimeAsync(50);
    // controller map, cancelling, cancellingTicks all cleaned
    expect((runner as any)._activeAbortControllers.has('late-job')).toBe(false);
    expect((runner as any).cancelling.has('late-job')).toBe(false);
    expect((runner as any).cancellingTicks.has('late-job')).toBe(false);
    // 强制 re-fire（hourly schedule 同 key 不重触发 / 手动清 lastRunKey 验证 reschedulable）
    (runner as any).lastRunKey.delete('late-job');
    runner.tick();
    expect((runner as any).running.has('late-job')).toBe(true);
    runner.stop();
  });

  // 反向 4: normal complete 后 controller map 清干净
  it('normal complete 路径 controller cleanup (no leak)', async () => {
    const audit = makeMockAudit();
    let handlerRan = false;
    const job: CronJob = {
      name: 'fast-job',
      enabled: true,
      schedule: { type: 'hourly' },
      handler: async () => {
        handlerRan = true;
        await new Promise(r => setTimeout(r, 10));
      },
    };
    const runner = new CronRunner([job], audit as any);
    runner.tick();
    await vi.advanceTimersByTimeAsync(50);  // 等 handler 完成
    expect(handlerRan).toBe(true);
    expect((runner as any)._activeAbortControllers.has('fast-job')).toBe(false);
    expect((runner as any).running.has('fast-job')).toBe(false);
    runner.stop();
  });
});
