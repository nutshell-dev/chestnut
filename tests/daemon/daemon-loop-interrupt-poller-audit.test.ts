/**
 * daemon-loop interrupt poller per-N audit emit (phase 123)
 *
 * 覆盖: non-ENOENT 错每 WARN_EVERY  emit ERROR audit,
 *       达 MAX_ERRORS emit DISABLED + clearInterval,
 *       ENOENT 不 increment count + 不 emit audit,
 *       unlink 成功后 reset count.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/daemon/inbox-watcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/inbox-watcher.js')>();
  return {
    ...actual,
    waitForInbox: vi.fn().mockResolvedValue(undefined),
  };
});

import { startDaemonLoop } from '../../src/daemon/daemon-loop.js';
import { DAEMON_AUDIT_EVENTS } from '../../src/daemon/audit-events.js';
import {
  INTERRUPT_POLL_INTERVAL_MS,
  INTERRUPT_POLL_WARN_EVERY,
  INTERRUPT_POLL_MAX_ERRORS,
} from '../../src/daemon/constants.js';

describe('daemon-loop interrupt poller audit (phase 123)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createHarness() {
    const audit = { write: vi.fn() };
    let resolveProcessBatch: ((v: number) => void) | undefined;
    let rejectProcessBatch: ((e: unknown) => void) | undefined;

    const runtime = {
      processBatch: vi.fn().mockImplementation(() => new Promise<number>((resolve, reject) => {
        resolveProcessBatch = resolve;
        rejectProcessBatch = reject;
      })),
      retryLastTurn: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
    };

    const mockFs = {
      deleteSync: vi.fn(),
      ensureDirSync: vi.fn(),
      writeAtomicSync: vi.fn(),
      readSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(false),
      listSync: vi.fn().mockReturnValue([]),
      resolve: vi.fn((p: string) => p),
    };

    const fsFactory = vi.fn().mockReturnValue(mockFs);

    const { promise, stop } = startDaemonLoop({
      runtime: runtime as unknown as Parameters<typeof startDaemonLoop>[0]['runtime'],
      agentDir: '/tmp/test-agent',
      clawId: 'test-claw',
      label: '[test]',
      audit: audit as unknown as Parameters<typeof startDaemonLoop>[0]['audit'],
      inbox: { pendingDir: '/tmp/test-agent/inbox/pending', fallbackTimeoutMs: 100_000 },
      fsFactory,
    });

    return {
      promise,
      stop,
      audit,
      runtime,
      mockFs,
      fsFactory,
      resolveProcessBatch,
      rejectProcessBatch,
    };
  }

  async function teardown(harness: ReturnType<typeof createHarness>) {
    harness.stop();
    harness.resolveProcessBatch?.(0);
    // advance past waitForInbox fallback timeout so the loop can drain and exit
    await vi.advanceTimersByTimeAsync(100_000 + 10);
    await harness.promise;
  }

  // --------------------------------------------------------------------------
  // 反向 1
  // --------------------------------------------------------------------------

  it('反向 1：non-ENOENT 错每 WARN_EVERY (=5) 次 emit ERROR audit', async () => {
    const h = createHarness();
    h.mockFs.deleteSync.mockImplementation(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });

    // let loop reach await processBatch (poller is already created)
    await vi.advanceTimersByTimeAsync(0);

    // advance 5 poller ticks
    await vi.advanceTimersByTimeAsync(INTERRUPT_POLL_INTERVAL_MS * INTERRUPT_POLL_WARN_EVERY);

    const errAudits = h.audit.write.mock.calls.filter(
      (c) => c[0] === DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_ERROR,
    );
    expect(errAudits).toHaveLength(1);
    expect(errAudits[0][1]).toBe('error_count=5');
    expect(errAudits[0][2]).toContain('last_error=');

    await teardown(h);
  });

  // --------------------------------------------------------------------------
  // 反向 2
  // --------------------------------------------------------------------------

  it('反向 2：累 MAX_ERRORS (=20) 后 emit DISABLED audit + clearInterval', async () => {
    const h = createHarness();
    h.mockFs.deleteSync.mockImplementation(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INTERRUPT_POLL_INTERVAL_MS * INTERRUPT_POLL_MAX_ERRORS);

    const errAudits = h.audit.write.mock.calls.filter(
      (c) => c[0] === DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_ERROR,
    );
    expect(errAudits).toHaveLength(4); // 5, 10, 15, 20

    const disabledAudits = h.audit.write.mock.calls.filter(
      (c) => c[0] === DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_DISABLED,
    );
    expect(disabledAudits).toHaveLength(1);
    expect(disabledAudits[0][1]).toBe('error_count=20');
    expect(disabledAudits[0][2]).toContain('last_error=');

    await teardown(h);
  });

  // --------------------------------------------------------------------------
  // 反向 3
  // --------------------------------------------------------------------------

  it('反向 3：ENOENT 错不 increment count + 不 emit audit', async () => {
    const h = createHarness();
    h.mockFs.deleteSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INTERRUPT_POLL_INTERVAL_MS * 30);

    const errAudits = h.audit.write.mock.calls.filter(
      (c) => c[0] === DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_ERROR,
    );
    expect(errAudits).toHaveLength(0);

    const disabledAudits = h.audit.write.mock.calls.filter(
      (c) => c[0] === DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_DISABLED,
    );
    expect(disabledAudits).toHaveLength(0);

    await teardown(h);
  });

  // --------------------------------------------------------------------------
  // 反向 4
  // --------------------------------------------------------------------------

  it('反向 4：unlink 成功后 reset count', async () => {
    const h = createHarness();

    // first 4 ticks: EIO (count=4, < WARN_EVERY)
    h.mockFs.deleteSync.mockImplementation(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INTERRUPT_POLL_INTERVAL_MS * 4);

    // next tick: success → reset count + abort
    h.mockFs.deleteSync.mockImplementation(() => {
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(INTERRUPT_POLL_INTERVAL_MS);
    expect(h.runtime.abort).toHaveBeenCalledTimes(1);

    // next 4 ticks: EIO again (count=4, < WARN_EVERY)
    h.mockFs.deleteSync.mockImplementation(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    await vi.advanceTimersByTimeAsync(INTERRUPT_POLL_INTERVAL_MS * 4);

    // total 8 EIO errors, but 0 ERROR audit (each segment < 5)
    const errAudits = h.audit.write.mock.calls.filter(
      (c) => c[0] === DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_ERROR,
    );
    expect(errAudits).toHaveLength(0);

    await teardown(h);
  });
});
