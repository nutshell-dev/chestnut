import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CRON_AUDIT_EVENTS } from '../../../src/foundation/cron/audit-events.js';
import { CronRunner, type CronJob, type CronEventSink } from '../../../src/foundation/cron/runner.js';

/**
 * Promise barrier release for the quick handler under fake timers.
 * Released explicitly by the test once the handler has been invoked.
 */
let handlerRelease: (() => void) | undefined;

// mock helper
function makeMockSink(): CronEventSink {
  return { write: vi.fn() } as unknown as CronEventSink;
}

describe('CronRunner timeout escalation', () => {
  let sink: CronEventSink;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 3, 21, 10, 30, 0) });
    sink = makeMockSink();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('handler 永挂 → timeout escalate + running 清 + cancelling 置 / 下 tick 被防御跳过', async () => {
    const HANG_HANDLER_TIMEOUT_MS = 100; // 永挂 handler 的显式超时预算。
    const HANG_TIMEOUT_OVERRUN_MS = 50; // 超时后再推进 50ms，确保 escalation 完成。
    const handler = vi.fn(() => new Promise<void>(() => {}));
    const job: CronJob = {
      name: 'hang',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      timeoutMs: HANG_HANDLER_TIMEOUT_MS,
    };
    const runner = new CronRunner([job], sink);
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect((runner as unknown as { running: Set<string> }).running.has('hang')).toBe(true);

    await vi.advanceTimersByTimeAsync(HANG_HANDLER_TIMEOUT_MS + HANG_TIMEOUT_OVERRUN_MS);

    expect(sink.write).toHaveBeenCalledWith(
      'cron_handler_timeout',
      'job=hang',
      expect.stringContaining('run_key='),
      `timeout_ms=${HANG_HANDLER_TIMEOUT_MS}`,
    );
    expect((runner as unknown as { running: Set<string> }).running.has('hang')).toBe(false);
    expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('hang')).toBe(true);

    // 下 tick 跨小时 key / 但 cancelling 防御应跳过（永挂 handler 未 settle）
    vi.setSystemTime(new Date(2026, 3, 21, 11, 30, 0));
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);   // 没 re-fire
  });

  it('handler 正常 settle 不误杀', async () => {
    const SETTLING_HANDLER_TIMEOUT_MS = 200; // 正常 settle 场景的宽松超时预算。
    const SETTLING_ADVANCE_MS = 100; // 在 200ms 超时前推进 100ms，验证不误杀。
    const handler = vi.fn(async () => {
      await new Promise<void>(r => { handlerRelease = r; });
    });
    const job: CronJob = {
      name: 'fast',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      timeoutMs: SETTLING_HANDLER_TIMEOUT_MS,
    };
    const runner = new CronRunner([job], sink);
    runner.tick();
    handlerRelease!();
    await vi.advanceTimersByTimeAsync(SETTLING_ADVANCE_MS);

    expect(sink.write).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('cron_handler_timeout'),
      expect.anything(),
      expect.anything(),
    );
    expect((runner as unknown as { running: Set<string> }).running.has('fast')).toBe(false);
  });

  it('handler 正常 throw 走 JOB_ERROR 路径', async () => {
    const THROWING_HANDLER_TIMEOUT_MS = 200; // 正常 throw 场景的显式超时预算。
    const THROWING_ADVANCE_MS = 50; // 在超时前推进 50ms，让 JOB_ERROR 路径完成。
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(async () => {
      throw new Error('test');
    });
    const job: CronJob = {
      name: 'thrower',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      timeoutMs: THROWING_HANDLER_TIMEOUT_MS,
    };
    const runner = new CronRunner([job], sink);
    runner.tick();
    await vi.advanceTimersByTimeAsync(THROWING_ADVANCE_MS);

    expect(sink.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.JOB_ERROR,
      'job=thrower',
      expect.stringContaining('run_key='),
      'error=test',
    );
    const timeoutCalls = sink.write.mock.calls.filter(
      (c: unknown[]) => c[0] === 'cron_handler_timeout'
    );
    expect(timeoutCalls).toHaveLength(0);
    expect((runner as unknown as { running: Set<string> }).running.has('thrower')).toBe(false);
    errSpy.mockRestore();
  });

  it('undefined timeoutMs 走原路径 regression', async () => {
    const UNDEFINED_REGRESSION_ADVANCE_MS = 10; // 推进 10ms，足以暴露 setTimeout(undefined) 的误触发。
    const LEGACY_POST_SETTLE_ADVANCE_MS = 100; // 再推进 100ms，等待 legacy handler 完成清理。
    const handler = vi.fn(async () => {
      await new Promise<void>(r => { handlerRelease = r; });
    });
    const job: CronJob = {
      name: 'legacy',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      // timeoutMs 未传
    };
    const runner = new CronRunner([job], sink);
    runner.tick();
    handlerRelease!();

    // 若误走 race 路径，setTimeout(undefined) → 0ms 立即触发 timeout audit
    await vi.advanceTimersByTimeAsync(UNDEFINED_REGRESSION_ADVANCE_MS);
    const timeoutCalls = sink.write.mock.calls.filter(
      (c: unknown[]) => c[0] === 'cron_handler_timeout'
    );
    expect(timeoutCalls).toHaveLength(0);

    // 等 handler 完成
    await vi.advanceTimersByTimeAsync(LEGACY_POST_SETTLE_ADVANCE_MS);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((runner as unknown as { running: Set<string> }).running.has('legacy')).toBe(false);
  });

  it('timeout 后下 tick 不并发再起（cancelling 防御）', async () => {
    const CANCELLING_HANDLER_TIMEOUT_MS = 100; // cancelling 防御场景的 handler 超时预算。
    const CANCELLING_TIMEOUT_OVERRUN_MS = 50; // 超时后再推进 50ms，确保进入 cancelling。
    const handler = vi.fn(() => new Promise<void>(() => {}));   // 永挂
    const job: CronJob = {
      name: 'hang',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      timeoutMs: CANCELLING_HANDLER_TIMEOUT_MS,
    };
    const runner = new CronRunner([job], sink);
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CANCELLING_HANDLER_TIMEOUT_MS + CANCELLING_TIMEOUT_OVERRUN_MS);
    // timeout 已发 / running 清 / cancelling 置
    expect((runner as unknown as { running: Set<string> }).running.has('hang')).toBe(false);
    expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('hang')).toBe(true);

    // 下 tick 跨小时 key（应可触发） / 但 cancelling 防御应跳过
    vi.setSystemTime(new Date(2026, 3, 21, 11, 30, 0));
    runner.tick();
    expect(handler).toHaveBeenCalledTimes(1);   // 没 re-fire
  });

  it('timeout 后 handler late reject 必 audit context=late_after_timeout', async () => {
    const LATE_REJECT_HANDLER_TIMEOUT_MS = 100; // late-reject 场景的 handler 超时预算。
    const LATE_REJECT_TIMEOUT_OVERRUN_MS = 50; // 超时后再推进 50ms，确保进入 late 状态。
    let rejectFn: (e: Error) => void = () => {};
    const handler = vi.fn(() => new Promise<void>((_, reject) => { rejectFn = reject; }));
    const job: CronJob = {
      name: 'late-rej',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
      timeoutMs: LATE_REJECT_HANDLER_TIMEOUT_MS,
    };
    const runner = new CronRunner([job], sink);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runner.tick();

    await vi.advanceTimersByTimeAsync(LATE_REJECT_HANDLER_TIMEOUT_MS + LATE_REJECT_TIMEOUT_OVERRUN_MS);
    // 此时 timeout 已发 / handler 仍未 settle
    expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('late-rej')).toBe(true);

    // handler 真 reject
    rejectFn(new Error('late-boom'));
    await vi.advanceTimersByTimeAsync(0);

    // late error audit 必发 / context=late_after_timeout
    const lateErrCalls = sink.write.mock.calls.filter(
      (c: unknown[]) => c[0] === CRON_AUDIT_EVENTS.JOB_ERROR
        && c.includes('context=late_after_timeout')
    );
    expect(lateErrCalls.length).toBe(1);
    // cancelling 清空 / 下次 tick 允许 retry
    expect((runner as unknown as { cancelling: Set<string> }).cancelling.has('late-rej')).toBe(false);

    errSpy.mockRestore();
  });
});
