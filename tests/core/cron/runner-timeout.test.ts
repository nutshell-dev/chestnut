import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import { CronRunner, type CronJob } from '../../../src/core/cron/runner.js';

// mock helper
function makeMockAudit(): { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() };
}

describe('CronRunner timeout escalation', () => {
  let audit: { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 3, 21, 10, 30, 0) });
    audit = makeMockAudit();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('handler 永挂 → timeout escalate + running 清 + cancelling 置 / 下 tick 被防御跳过', async () => {
    const handler = vi.fn(() => new Promise<void>(() => {}));
    const job: CronJob = {
      name: 'hang',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      timeoutMs: 100,
    };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect((runner as unknown as { running: Set<string> }).running.has('hang')).toBe(true);

    await vi.advanceTimersByTimeAsync(150);

    expect(audit.write).toHaveBeenCalledWith(
      'cron_handler_timeout',
      'job=hang',
      expect.stringContaining('run_key='),
      'timeout_ms=100',
    );
    expect((runner as unknown as { running: Set<string> }).running.has('hang')).toBe(false);
    expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('hang')).toBe(true);

    // 下 tick 跨小时 key / 但 cancelling 防御应跳过（永挂 handler 未 settle）
    vi.setSystemTime(new Date(2026, 3, 21, 11, 30, 0));
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);   // 没 re-fire
  });

  it('handler 正常 settle 不误杀', async () => {
    const handler = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 50));
    });
    const job: CronJob = {
      name: 'fast',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      timeoutMs: 200,
    };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    await vi.advanceTimersByTimeAsync(100);

    expect(audit.write).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('cron_handler_timeout'),
      expect.anything(),
      expect.anything(),
    );
    expect((runner as unknown as { running: Set<string> }).running.has('fast')).toBe(false);
  });

  it('handler 正常 throw 走 JOB_ERROR 路径', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(async () => {
      throw new Error('test');
    });
    const job: CronJob = {
      name: 'thrower',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      timeoutMs: 200,
    };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    await vi.advanceTimersByTimeAsync(50);

    expect(audit.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.JOB_ERROR,
      'job=thrower',
      expect.stringContaining('run_key='),
      'error=test',
    );
    const timeoutCalls = audit.write.mock.calls.filter(
      (c: unknown[]) => c[0] === 'cron_handler_timeout'
    );
    expect(timeoutCalls).toHaveLength(0);
    expect((runner as unknown as { running: Set<string> }).running.has('thrower')).toBe(false);
    errSpy.mockRestore();
  });

  it('undefined timeoutMs 走原路径 regression', async () => {
    const handler = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 50));
    });
    const job: CronJob = {
      name: 'legacy',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      // timeoutMs 未传
    };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();

    // 若误走 race 路径，setTimeout(undefined) → 0ms 立即触发 timeout audit
    await vi.advanceTimersByTimeAsync(10);
    const timeoutCalls = audit.write.mock.calls.filter(
      (c: unknown[]) => c[0] === 'cron_handler_timeout'
    );
    expect(timeoutCalls).toHaveLength(0);

    // 等 handler 完成
    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((runner as unknown as { running: Set<string> }).running.has('legacy')).toBe(false);
  });

  it('timeout 后下 tick 不并发再起（cancelling 防御）', async () => {
    const handler = vi.fn(() => new Promise<void>(() => {}));   // 永挂
    const job: CronJob = {
      name: 'hang',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      timeoutMs: 100,
    };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(150);
    // timeout 已发 / running 清 / cancelling 置
    expect((runner as unknown as { running: Set<string> }).running.has('hang')).toBe(false);
    expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('hang')).toBe(true);

    // 下 tick 跨小时 key（应可触发） / 但 cancelling 防御应跳过
    vi.setSystemTime(new Date(2026, 3, 21, 11, 30, 0));
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);   // 没 re-fire
  });

  it('timeout 后 handler late reject 必 audit context=late_after_timeout', async () => {
    let rejectFn: (e: Error) => void = () => {};
    const handler = vi.fn(() => new Promise<void>((_, reject) => { rejectFn = reject; }));
    const job: CronJob = {
      name: 'late-rej',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      timeoutMs: 100,
    };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runner.tick();

    await vi.advanceTimersByTimeAsync(150);
    // 此时 timeout 已发 / handler 仍未 settle
    expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('late-rej')).toBe(true);

    // handler 真 reject
    rejectFn(new Error('late-boom'));
    await vi.advanceTimersByTimeAsync(0);

    // late error audit 必发 / context=late_after_timeout
    const lateErrCalls = audit.write.mock.calls.filter(
      (c: unknown[]) => c[0] === CRON_AUDIT_EVENTS.JOB_ERROR
        && c.includes('context=late_after_timeout')
    );
    expect(lateErrCalls.length).toBe(1);
    // cancelling 清空 / 下次 tick 允许 retry
    expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('late-rej')).toBe(false);

    errSpy.mockRestore();
  });
});
