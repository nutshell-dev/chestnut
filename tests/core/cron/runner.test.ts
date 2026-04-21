import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Audit } from '../../../src/foundation/audit/index.js';
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

  it('parses "interval:5m" → { type: "interval", minutes: 5 }', () => {
    expect(parseSchedule('interval:5m')).toEqual({ type: 'interval', minutes: 5 });
  });

  it('unknown format falls back to hourly + console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSchedule('bogus')).toEqual({ type: 'hourly' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown schedule format "bogus"'));
    warnSpy.mockRestore();
  });

  it('unknown format + audit → cron_parse_fallback audit written', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = makeMockAudit();
    parseSchedule('bogus', audit as unknown as Audit);
    expect(audit.write).toHaveBeenCalledWith('cron_parse_fallback', 'input=bogus', 'fallback=hourly');
    warnSpy.mockRestore();
  });

  it('empty string falls back', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSchedule('')).toEqual({ type: 'hourly' });
    warnSpy.mockRestore();
  });

  it('interval:0m parses minutes=0（边界）', () => {
    expect(parseSchedule('interval:0m')).toEqual({ type: 'interval', minutes: 0 });
  });

  it('daily:25:99 parses 原始字符串 time="25:99"（无格式验证）', () => {
    expect(parseSchedule('daily:25:99')).toEqual({ type: 'daily', time: '25:99' });
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
    const runner = new CronRunner([job], audit as unknown as Audit);
    runner.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    runner.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it('stop clears timer; subsequent tick no-op', () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as Audit);
    runner.start();
    runner.stop();
    vi.advanceTimersByTime(5000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('tick triggers enabled job', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as Audit);
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('tick skips disabled job', () => {
    const handler = vi.fn();
    const job: CronJob = { name: 'test', enabled: false, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as Audit);
    runner.tick();
    expect(handler).not.toHaveBeenCalled();
  });

  it('tick dedupes within same run key', () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as Audit);
    runner.tick();
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('tick prevents concurrent handler execution (running guard)', async () => {
    let resolveFn: () => void;
    const handler = vi.fn(() => new Promise<void>((r) => { resolveFn = r; }));
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as Audit);
    runner.tick();
    // handler 未 resolve，running.has('test') = true
    // 强制跨 key（advance 到下小时）
    vi.setSystemTime(new Date(2026, 3, 21, 11, 30, 0));
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1); // 仍然只调一次
    resolveFn!();
    await vi.runAllTicks();
  });

  it('handler error → cron_job_error audit + console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const job: CronJob = { name: 'failing', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as Audit);
    runner.tick();
    await vi.runAllTicks();
    expect(audit.write).toHaveBeenCalledWith(
      'cron_job_error',
      'job=failing',
      expect.stringContaining('run_key='),
      'err=boom',
    );
    expect(errSpy).toHaveBeenCalled();
  });

  it('computeRunKey: hourly format', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'hourly' }, handler };
    const runner = new CronRunner([job], audit as unknown as Audit);
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
    const runner = new CronRunner([job], audit as unknown as Audit);
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
    const job: CronJob = { name: 'test', enabled: true, schedule: { type: 'interval', minutes: 30 }, handler };
    const runner = new CronRunner([job], audit as unknown as Audit);
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    // advance 30 min（跨 block）
    vi.setSystemTime(new Date(2026, 3, 21, 11, 0, 0));
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
