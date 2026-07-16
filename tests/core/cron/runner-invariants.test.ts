/**
 * runner invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - runner-stop-drain.test.ts
 *  - runner-stop-drain-timer-cleanup.test.ts
 *  - runner-drain-late-settle.test.ts
 *  - runner-abort-signal.test.ts
 *  - runner-handler-stuck.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../../../src/foundation/cron/audit-events.js';
import { CronRunner } from '../../../src/foundation/cron/runner.js';
import type { CronJob } from '../../../src/foundation/cron/runner.js';
import { CRON_TICK_INTERVAL_MS } from '../../../src/foundation/cron/constants.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

describe('runner-stop-drain', () => {
  // mock helper
  function makeMockAudit(): { write: ReturnType<typeof vi.fn> } {
    return { write: vi.fn() };
  }

  describe('CronRunner.stop drain (phase 793 / P0.22)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: new Date(2026, 5, 25, 10, 0, 0) });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('drains inflight handlers before resolving stop', async () => {
      let handlerResolved = false;
      const slowHandler = () => new Promise<void>(resolve => setTimeout(() => {
        handlerResolved = true;
        resolve();
      }, 200));

      const audit = makeMockAudit();
      const runner = new CronRunner([{
        name: 'slow', enabled: true,
        schedule: { type: 'hourly' },
        handler: slowHandler,
      }], audit as unknown as AuditLog);

      runner.start();
      runner.tick();  // 触发 schedule slowHandler

      // stop 应等 handler settle
      const stopPromise = runner.stop(1000);   // cap 1s > handler 200ms
      await vi.advanceTimersByTimeAsync(250);
      await stopPromise;

      expect(handlerResolved).toBe(true);
    });

    it('drains with cap timeout when handler exceeds cap', async () => {
      const hangingHandler = () => new Promise<void>(() => { /* never resolve */ });

      const audit = makeMockAudit();
      const runner = new CronRunner([{
        name: 'hang', enabled: true,
        schedule: { type: 'hourly' },
        handler: hangingHandler,
      }], audit as unknown as AuditLog);

      runner.start();
      runner.tick();

      const stopPromise = runner.stop(100);   // cap 100ms
      await vi.advanceTimersByTimeAsync(150);
      await stopPromise;

      // 期 audit RUNNER_DRAIN_TIMEOUT 写
      const calls = (audit.write as any).mock.calls;
      const timeoutCalls = calls.filter((c: any) => c[0] === CRON_AUDIT_EVENTS.RUNNER_DRAIN_TIMEOUT);
      expect(timeoutCalls.length).toBe(1);
    });
  });
});

describe('runner-stop-drain-timer-cleanup', () => {
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
});

describe('runner-drain-late-settle', () => {
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
});

describe('runner-abort-signal', () => {
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
});

describe('runner-handler-stuck', () => {
  class MockAudit {
    events: Array<{ type: string; cols: string[] }> = [];
    write(type: string, ...cols: (string | number)[]) {
      this.events.push({ type, cols: cols.map(String) });
    }
  }

  describe('CronRunner — handler stuck watchdog (P1.14)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: new Date(2026, 3, 21, 10, 30, 0) });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('handler 永挂 + timeout + N ticks 后 audit HANDLER_STUCK 并标记 degraded，cancelling 继续阻塞同名 job', async () => {
      const audit = new MockAudit();
      const stuckHandler = vi.fn(() => new Promise<void>(() => {})); // 永挂
      const job: CronJob = {
        name: 'stuck-job',
        enabled: true,
        schedule: { type: 'interval', minutes: 1 },
        handler: stuckHandler,
        timeoutMs: 100,
      };
      const runner = new CronRunner([job], audit as unknown as AuditLog);

      runner.tick(); // 触发 handler 执行
      await vi.advanceTimersByTimeAsync(150); // timeoutMs 100 触发

      // 此时 cancelling 含 stuck-job / cancellingTicks=0
      expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('stuck-job')).toBe(true);

      // 10 次 tick 模拟（CANCELLING_STUCK_TICKS=10）
      for (let i = 0; i < 10; i++) {
        runner.tick();
      }

      // 第 10 tick 触发 HANDLER_STUCK audit
      const stuckAudits = audit.events.filter(e => e.type === CRON_AUDIT_EVENTS.HANDLER_STUCK);
      expect(stuckAudits.length).toBe(1);
      expect(stuckAudits[0]!.cols).toContain('job=stuck-job');
      expect(stuckAudits[0]!.cols.some(c => c.startsWith('ticks='))).toBe(true);

      // Phase 1073: cancelling 不清除，继续阻塞；stuckJobs 标记 degraded
      expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('stuck-job')).toBe(true);
      expect((runner as unknown as { stuckJobs: Set<string> }).stuckJobs.has('stuck-job')).toBe(true);

      // 再 tick 到下一 interval block，同名 job 仍被跳过
      vi.setSystemTime(new Date(2026, 3, 21, 10, 31, 0));
      runner.tick();
      expect(stuckHandler).toHaveBeenCalledTimes(1);
    });

    it('handler 正常 settle 不触发 stuck watchdog', async () => {
      const audit = new MockAudit();
      const okHandler = vi.fn(async () => {});
      const job: CronJob = {
        name: 'ok-job',
        enabled: true,
        schedule: { type: 'interval', minutes: 1 },
        handler: okHandler,
        timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
      };
      const runner = new CronRunner([job], audit as unknown as AuditLog);

      runner.tick();
      await vi.advanceTimersByTimeAsync(50); // 远未到 timeoutMs，handler 已 settle

      // 多次 tick / handler 已 settle / cancelling 0 / 永不入 stuck watchdog
      for (let i = 0; i < 15; i++) runner.tick();
      expect(audit.events.filter(e => e.type === CRON_AUDIT_EVENTS.HANDLER_STUCK)).toEqual([]);
    });

    it('handler late-settle 在 stuck audit 之前 不触发 stuck', async () => {
      let resolveFn: () => void = () => {};
      const audit = new MockAudit();
      const lateHandler = vi.fn(() => new Promise<void>((r) => { resolveFn = r; }));
      const job: CronJob = {
        name: 'late-job',
        enabled: true,
        schedule: { type: 'interval', minutes: 1 },
        handler: lateHandler,
        timeoutMs: 100,
      };
      const runner = new CronRunner([job], audit as unknown as AuditLog);

      runner.tick();
      await vi.advanceTimersByTimeAsync(150); // timeout 触发
      expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('late-job')).toBe(true);

      // 8 次 tick（ticks 累计到 8，未满 10）
      for (let i = 0; i < 8; i++) {
        runner.tick();
      }

      // handler 在第 8 tick 后 settle（在 stuck 阈值 10 之前）
      resolveFn();
      await vi.runAllTicks(); // flush microtask，让 then 回调执行

      // 再 tick 几次，cancelling 已清，不应触发 HANDLER_STUCK
      for (let i = 0; i < 5; i++) {
        runner.tick();
      }

      expect(audit.events.filter(e => e.type === CRON_AUDIT_EVENTS.HANDLER_STUCK)).toEqual([]);
      // late_after_timeout 也不应有（late-settle resolve 路径不 audit JOB_ERROR）
      expect(audit.events.filter(e => e.type === CRON_AUDIT_EVENTS.JOB_ERROR)).toEqual([]);
    });
  });
});
