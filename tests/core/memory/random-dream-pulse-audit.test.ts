import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForTaskResult } from '../../../src/core/memory/random-dream.js';
import { MEMORY_AUDIT_EVENTS } from '../../../src/core/memory/audit-events.js';

describe('random-dream — ⚓11 pulse strategy α (phase 633)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeMotionFs(returnFalseCount = Infinity) {
    let calls = 0;
    return {
      existsSync: vi.fn(() => {
        calls++;
        return calls > returnFalseCount;
      }),
      readSync: vi.fn(() => 'log-content'),
    };
  }

  it('default behavior: pulseAuditEnabled=false → 0 RANDOM_DREAM_PULSE audit', async () => {
    const motionFs = makeMotionFs();
    const audit = { write: vi.fn() };
    const promise = waitForTaskResult(motionFs as any, 't1', 100, 10, audit, false);
    await vi.advanceTimersByTimeAsync(200);
    // promise resolves to null on timeout; no need to await
    const pulseCalls = audit.write.mock.calls.filter((c: any[]) =>
      c[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_PULSE
    );
    expect(pulseCalls).toHaveLength(0);
    await promise;
  });

  it('pulseAuditEnabled=true → emits RANDOM_DREAM_PULSE per poll', async () => {
    const motionFs = makeMotionFs(2); // 2 false → 2 pulses, then true on 3rd check
    const audit = { write: vi.fn() };
    const promise = waitForTaskResult(motionFs as any, 't2', 100, 10, audit, true);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result).toBe('log-content');

    const pulseCalls = audit.write.mock.calls.filter((c: any[]) =>
      c[0] === MEMORY_AUDIT_EVENTS.RANDOM_DREAM_PULSE
    );
    expect(pulseCalls.length).toBeGreaterThanOrEqual(2);
    expect(pulseCalls[0][1]).toContain('taskId=t2');
    expect(pulseCalls[0][2]).toContain('pulse=0');
    expect(pulseCalls[0][3]).toContain('interval_ms=10');
    expect(pulseCalls[1][2]).toContain('pulse=1');
  });

  it('pulseIntervalMs default 30_000 when opts undefined', async () => {
    const motionFs = makeMotionFs();
    const audit = { write: vi.fn() };
    const promise = waitForTaskResult(motionFs as any, 't3', 200_000, undefined, audit, true);
    // Synchronous part of waitForTaskResult runs first while-loop iteration
    // (existsSync=false → audit pulse=0 → setTimeout 30_000).
    expect(audit.write).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(audit.write).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(audit.write).toHaveBeenCalledTimes(3);

    // Let it timeout so the promise resolves and test cleans up
    await vi.advanceTimersByTimeAsync(200_000);
    await promise;
  });
});
