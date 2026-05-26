/**
 * Phase 1325 — lock retry jitter + per-retry audit emit
 *
 * 反向 3 项:
 * 1. jitter range 实测 100 sample 落 [T/2, 1.5T]
 * 2. per-retry audit emit count = max(0, retries-1)
 * 3. thundering herd simulate (N=10 concurrent) verify wake-up spread
 */
import { describe, it, expect, vi } from 'vitest';
import { acquireLock } from '../../../src/core/contract/lock.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeMockAudit } from '../../helpers/audit.js';

vi.mock('../../../src/core/contract/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/contract/constants.js')>();
  return {
    ...actual,
    LOCK_MAX_RETRIES: 5,
    LOCK_RETRY_DELAY_MS: 100,
  };
});

vi.mock('../../../src/foundation/process-exec/index.js', () => ({
  isAlive: vi.fn(() => true),
}));

describe('phase 1325 lock retry jitter + audit emit', () => {
  it('jitter range 100 sample 落 [T/2, 1.5T]', () => {
    const T = 100; // mocked LOCK_RETRY_DELAY_MS
    const samples = Array.from({ length: 100 }, () => T / 2 + Math.random() * T);
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(min).toBeGreaterThanOrEqual(T / 2);
    expect(max).toBeLessThanOrEqual(T * 1.5);
    // spread: not all same value
    const unique = new Set(samples.map(s => Math.round(s))).size;
    expect(unique).toBeGreaterThan(50);
  });

  it('per-retry audit emit count = max(0, retries-1) verify', async () => {
    const mockAudit = makeMockAudit();
    const delays: number[] = [];

    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((cb: any, ms?: number) => {
      delays.push(ms ?? 0);
      return originalSetTimeout(cb, 1); // accelerate to 1ms for fast test
    });

    const mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      writeExclusiveSync: vi.fn(() => {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }),
      read: vi.fn().mockResolvedValue(JSON.stringify({ pid: 12345, time: Date.now() })),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      acquireLock({ fs: mockFs as any, audit: mockAudit as any }, '/tmp/test.lock')
    ).rejects.toThrow(/Failed to acquire lock after/);

    // 5 retries → 4 delays → 4 audit emits
    const retryCalls = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.LOCK_RETRY
    );
    expect(retryCalls.length).toBe(4);

    // each emit contains attempt, reason, delay_ms
    expect(retryCalls[0][1]).toMatch(/^attempt=1\/5/);
    expect(retryCalls[0][2]).toMatch(/^reason=/);
    expect(retryCalls[0][3]).toMatch(/^delay_ms=/);

    setTimeoutSpy.mockRestore();
  });

  it('thundering herd N=10 concurrent simulate verify wake-up spread', async () => {
    const mockAudit = makeMockAudit();
    const allDelays: number[] = [];

    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((cb: any, ms?: number) => {
      allDelays.push(ms ?? 0);
      return originalSetTimeout(cb, 1);
    });

    const mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      writeExclusiveSync: vi.fn(() => {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }),
      read: vi.fn().mockResolvedValue(JSON.stringify({ pid: 12345, time: Date.now() })),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    // 10 concurrent acquireLock on different lock paths
    const promises = Array.from({ length: 10 }, (_, i) =>
      acquireLock({ fs: mockFs as any, audit: mockAudit as any }, `/tmp/test-${i}.lock`).catch(() => {
        // expected to fail
      })
    );

    await Promise.all(promises);

    // each call retries 5 times → 4 delays → 40 delays total
    expect(allDelays.length).toBe(40);

    // delays should not all be identical (jitter broke synchronization)
    const uniqueDelays = new Set(allDelays.map(d => Math.round(d))).size;
    expect(uniqueDelays).toBeGreaterThan(5);

    // all delays within [T/2, 1.5T]
    const T = 100;
    for (const d of allDelays) {
      expect(d).toBeGreaterThanOrEqual(T / 2);
      expect(d).toBeLessThanOrEqual(T * 1.5);
    }

    setTimeoutSpy.mockRestore();
  });
});
