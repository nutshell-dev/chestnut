import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../../../src/foundation/cron/audit-events.js';
import { CronRunner, type CronJob } from '../../../src/foundation/cron/runner.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

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

  it('handler 永挂 + timeout + N ticks 后 audit HANDLER_STUCK 并清 cancelling', async () => {
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

    // cancelling 已清
    expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('stuck-job')).toBe(false);
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
