import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import {
  CronRunner,
  parseSchedule,
  type CronSchedule,
  type CronJob,
} from '../../../src/core/cron/runner.js';

// mock helper
function makeMockAudit(): { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() };
}

describe('parseSchedule', () => {
  it('parses "hourly" → { type: "hourly" }', () => {
    expect(parseSchedule('hourly')).toEqual({ type: 'hourly' });
  });

  it('parses "daily:06:00" → { type: "daily", time: "06:00" }', () => {
    expect(parseSchedule('daily:06:00')).toEqual({ type: 'daily', time: '06:00' });
  });

  it('parses "interval:5m" → { type: "interval", ms: 300_000 }', () => {
    expect(parseSchedule('interval:5m')).toEqual({ type: 'interval', ms: 300_000 });
  });

  it('unknown format falls back to hourly (no console.warn)', () => {
    expect(parseSchedule('bogus')).toEqual({ type: 'hourly' });
  });

  it('unknown format + audit → cron_parse_fallback audit written', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeMockAudit();
    parseSchedule('bogus', audit as unknown as AuditLog);
    expect(audit.write).toHaveBeenCalledWith(CRON_AUDIT_EVENTS.PARSE_FALLBACK, 'input=bogus', 'fallback=hourly');
    warnSpy.mockRestore();
  });

  it('empty string falls back', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSchedule('')).toEqual({ type: 'hourly' });
    warnSpy.mockRestore();
  });

  it('interval:0m returns null（G3 验证）', () => {
    const audit = makeMockAudit();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSchedule('interval:0m', audit as unknown as AuditLog)).toBeNull();
    expect(audit.write).toHaveBeenCalledWith(CRON_AUDIT_EVENTS.PARSE_INVALID, 'input=interval:0m', 'reason=invalid_interval');
    warnSpy.mockRestore();
  });

  it('daily:25:99 returns null（G3 验证）', () => {
    const audit = makeMockAudit();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSchedule('daily:25:99', audit as unknown as AuditLog)).toBeNull();
    expect(audit.write).toHaveBeenCalledWith(CRON_AUDIT_EVENTS.PARSE_INVALID, 'input=daily:25:99', 'reason=invalid_daily_time');
    warnSpy.mockRestore();
  });
});

describe('CronRunner', () => {
  let audit: { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 3, 21, 10, 30, 0) });
    audit = makeMockAudit();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('start is idempotent（重复调 timer 唯一）', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler: vi.fn() };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    runner.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it('start() writes cron_runner_started audit', () => {
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler: vi.fn() };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.start();
    expect(audit.write).toHaveBeenCalledWith(CRON_AUDIT_EVENTS.RUNNER_STARTED, 'jobs=1');
    runner.stop();
  });

  it('stop() writes cron_runner_stopped audit', () => {
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler: vi.fn() };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.start();
    audit.write.mockClear();
    runner.stop();
    expect(audit.write).toHaveBeenCalledWith(CRON_AUDIT_EVENTS.RUNNER_STOPPED, 'jobs=1');
  });

  it('stop clears timer; subsequent tick no-op', () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.start();
    runner.stop();
    vi.advanceTimersByTime(5000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('tick triggers enabled job', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('tick skips disabled job', () => {
    const handler = vi.fn();
    const job: CronJob = { name: 'test', enabled: false, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    expect(handler).not.toHaveBeenCalled();
  });

  it('tick dedupes within same run key', () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('tick prevents concurrent handler execution (running guard)', async () => {
    let resolveFn: () => void;
    const handler = vi.fn(() => new Promise<void>((r) => { resolveFn = r; }));
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    // handler 未 resolve，running.has('test') = true
    // 强制跨 key（advance 到下小时）
    vi.setSystemTime(new Date(2026, 3, 21, 11, 30, 0));
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1); // 仍然只调一次
    resolveFn!();
    await vi.runAllTicks();
  });

  it('handler error → cron_job_error audit (no console.error)', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const job: CronJob = { name: 'failing', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    await vi.runAllTicks();
    expect(audit.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.JOB_ERROR,
      'job=failing',
      expect.stringContaining('run_key='),
      'error=boom',
    );
  });

  it('computeRunKey: hourly format', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    vi.setSystemTime(new Date(2026, 3, 21, 11, 30, 0));
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(2); // 新小时 key
  });

  it('computeRunKey: daily pending 态（未到目标时刻）', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'daily', time: '06:00' }, handler };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    // 当前 10:30 >= 06:00 → 今日 key 立即触发
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    // 明日 05:00（pending 态）再 tick
    vi.setSystemTime(new Date(2026, 3, 22, 5, 0, 0));
    runner.tick();
    // pending key 与昨日完成 key 不同 → 会触发
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('computeRunKey: interval block', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'interval', ms: 30 * 60 * 1000 }, handler };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    // advance 30 min（跨 block）
    vi.setSystemTime(new Date(2026, 3, 21, 11, 0, 0));
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('handler timeout 后 background settle → emit JOB_LATE_SETTLED 含 job + run_key + late_settle_ms', async () => {
    let resolveHandler: () => void;
    const handler = vi.fn(() => new Promise<void>((r) => { resolveHandler = r; }));
    const job: CronJob = { name: 'slow', enabled: true, schedule: { type: 'hourly' }, handler, timeoutMs: 100 };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);

    // advance  past timeout → HANDLER_TIMEOUT
    vi.advanceTimersByTime(101);
    expect(audit.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.HANDLER_TIMEOUT,
      'job=slow',
      expect.stringContaining('run_key='),
      'timeout_ms=100',
    );

    // background settle → JOB_LATE_SETTLED
    resolveHandler!();
    await vi.runAllTicks();

    const lateSettledCall = audit.write.mock.calls.find((c: any[]) =>
      c[0] === CRON_AUDIT_EVENTS.JOB_LATE_SETTLED
    );
    expect(lateSettledCall).toBeTruthy();
    expect(lateSettledCall![1]).toBe('job=slow');
    expect(lateSettledCall![2]).toMatch(/^run_key=/);
    expect(lateSettledCall![3]).toMatch(/^late_settle_ms=\d+$/);
  });

  it('handler timeout 后 background error → emit JOB_ERROR context=late_after_timeout', async () => {
    let rejectHandler: (e: Error) => void;
    const handler = vi.fn(() => new Promise<void>((_, r) => { rejectHandler = r; }));
    const job: CronJob = { name: 'failing-late', enabled: true, schedule: { type: 'hourly' }, handler, timeoutMs: 100 };
    const runner = new CronRunner([job], audit as unknown as AuditLog);
    runner.tick();

    vi.advanceTimersByTime(101);
    rejectHandler!(new Error('late boom'));
    await vi.runAllTicks();

    expect(audit.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.JOB_ERROR,
      'job=failing-late',
      expect.stringContaining('run_key='),
      'error=late boom',
      'context=late_after_timeout',
    );
  });
});
