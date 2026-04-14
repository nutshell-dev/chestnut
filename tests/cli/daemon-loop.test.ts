/**
 * daemon-loop tests
 *
 * fix 7 — waitForInbox done() idempotency (settled guard prevents double-resolve)
 * fix 9 — interrupt poller circuit breaker (disables after 20 consecutive errors)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as fsNative from 'fs';
import * as os from 'os';
import * as path from 'path';
import { waitForInbox, startDaemonLoop } from '../../src/cli/commands/daemon-loop.js';
import type { ClawRuntime } from '../../src/core/runtime.js';
import { writeInboxMessage } from '../../src/utils/inbox-writer.js';

// Module-level mock so ESM named exports are replaceable
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) };
});

vi.mock('../../src/utils/inbox-writer.js', () => ({
  writeInboxMessage: vi.fn(),
}));

// ─── fix 7: waitForInbox idempotency ──────────────────────────────────────────

describe('waitForInbox', () => {
  it('resolves via timeout when dir does not exist (mkdirSync throws → done() via catch, then timer fires)', async () => {
    vi.useFakeTimers();

    // '/nonexistent-fs-watch-path' will cause mkdirSync to fail in some environments,
    // but mkdirSync with { recursive: true } on a bad path may not throw on macOS.
    // So use a path that will trigger the watcher error path instead.
    const p = waitForInbox('/tmp/__daemon_test_no_inbox__', 1000);

    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toBeUndefined();

    vi.useRealTimers();
  });

  it('resolves before timeout when a file is created in the watched dir', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'daemon-inbox-test-'));
    try {
      const timeoutMs = 5000;
      const p = waitForInbox(tmpDir, timeoutMs);

      // Write a file to trigger fs.watch event
      await fsp.writeFile(path.join(tmpDir, 'msg.md'), 'test');

      // Should resolve well before 5s timeout
      await expect(p).resolves.toBeUndefined();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('calling done() multiple times via timeout does not reject or hang', async () => {
    vi.useFakeTimers();
    const p = waitForInbox('/tmp/__daemon_test_double__', 500);
    // Advance twice to ensure timer fires and any second invocation is guarded
    vi.advanceTimersByTime(600);
    vi.advanceTimersByTime(600);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

// ─── fix 9: interrupt poller circuit breaker ──────────────────────────────────

describe('startDaemonLoop interrupt poller circuit breaker', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // unlinkSync is already replaced by the module-level vi.mock above
    vi.mocked(fsNative.unlinkSync).mockImplementation(() => {
      throw new Error('eperm');
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(fsNative.unlinkSync).mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('disables interrupt poller after 20 consecutive errors', async () => {
    // processBatch returns 0 → daemon goes to waitForInbox
    // The try block starts the interrupt poller, then awaits processBatch/waitForInbox
    // We want to advance timers to trigger the poller 20 times
    const processBatch = vi.fn().mockResolvedValue(0);
    const mockRuntime = {
      processBatch,
      abort: vi.fn(),
      retryLastTurn: vi.fn(),
    } as unknown as ClawRuntime;

    const { stop } = startDaemonLoop({
      runtime: mockRuntime,
      agentDir: '/tmp/test-agent-fix9',
      clawId: 'test-agent-fix9',
      inboxPendingDir: '/tmp/test-inbox-fix9',
      label: '[test-fix9]',
      fallbackTimeoutMs: 60_000,
    });

    // Let processBatch resolve (tick microtasks)
    await Promise.resolve();

    // Advance 200ms × 21 to trigger the poller 20+ times
    for (let i = 0; i < 21; i++) {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    }

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('disabling'),
    );

    stop();
    // Advance to flush waitForInbox timeout so the loop can terminate cleanly
    vi.advanceTimersByTime(60_001);
    await Promise.resolve();
  });
});

// ─── LLM retry ────────────────────────────────────────────────────────────────

/** Flush the microtask queue n times to let async code advance */
async function flushMicrotasks(n = 6) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('startDaemonLoop - LLM retry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(writeInboxMessage).mockReset();
  });

  it('LLM error triggers retryLastTurn after exponential delay', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retryLastTurn = vi.fn().mockResolvedValue(undefined);
    const processBatch = vi.fn()
      .mockRejectedValueOnce(new Error('All providers failed: network unreachable'))
      .mockResolvedValue(0);

    const mockRuntime = { processBatch, retryLastTurn, abort: vi.fn() } as unknown as ClawRuntime;

    const { stop } = startDaemonLoop({
      runtime: mockRuntime,
      agentDir: '/tmp/daemon-llm-retry-test',
      clawId: 'daemon-llm-retry-test',
      inboxPendingDir: '/tmp/daemon-llm-retry-test/inbox/pending',
      label: '[retry-test]',
      fallbackTimeoutMs: 1_000,
    });

    // Let processBatch throw and catch block reach the 30s setTimeout
    await flushMicrotasks();

    // Advance past the retry delay
    vi.advanceTimersByTime(30_001);
    await flushMicrotasks();

    // retryLastTurn must have been called
    expect(retryLastTurn).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retrying'));

    stop();
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();
    warnSpy.mockRestore();
  });

  it('LLM max retries exhausted fires appendFileSync and writeInboxMessage to motionDir', async () => {
    vi.useFakeTimers();
    const appendSpy = vi.spyOn(fsNative, 'appendFileSync').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy  = vi.spyOn(console, 'error').mockImplementation(() => {});

    // processBatch throws once; retryLastTurn always throws → 3 retries → max exceeded
    const processBatch  = vi.fn().mockRejectedValueOnce(new Error('All providers failed'));
    const retryLastTurn = vi.fn().mockRejectedValue(new Error('All providers failed on retry'));
    const mockRuntime = { processBatch, retryLastTurn, abort: vi.fn() } as unknown as ClawRuntime;

    const notifyMotionDir = '/tmp/motion-max-retry-notify';

    const { stop } = startDaemonLoop({
      runtime: mockRuntime,
      agentDir: '/tmp/agent-max-retry',
      clawId: 'agent-max-retry',
      inboxPendingDir: '/tmp/agent-max-retry/inbox/pending',
      label: '[max-retry-test]',
      fallbackTimeoutMs: 100,
      notifyMotionDir,
    });

    // Iteration 1: processBatch throws → wait 30 s
    await flushMicrotasks();
    vi.advanceTimersByTime(30_001);
    await flushMicrotasks();

    // Iteration 2: retryLastTurn throws → wait 60 s
    vi.advanceTimersByTime(60_001);
    await flushMicrotasks();

    // Iteration 3: retryLastTurn throws → wait 120 s
    vi.advanceTimersByTime(120_001);
    await flushMicrotasks();

    // Iteration 4: retryLastTurn throws → llmRetryCount=3 >= MAX → else branch → notify
    // appendFileSync and writeInboxMessage are synchronous and fire in the catch block

    expect(appendSpy).toHaveBeenCalledWith(
      path.join(notifyMotionDir, 'stream.jsonl'),
      expect.any(String),
    );
    const appendedLine: string = appendSpy.mock.calls[0][1] as string;
    const event = JSON.parse(appendedLine.trim());
    expect(event.type).toBe('user_notify');
    expect(event.subtype).toBe('llm_error');
    expect(event.clawId).toBe('agent-max-retry');
    expect(typeof event.error).toBe('string');
    expect(typeof event.ts).toBe('number');
    expect(vi.mocked(writeInboxMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'watchdog_claw_llm_error' }),
    );

    stop();
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    appendSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('non-LLM error does not set llmRetryPending and skips retryLastTurn', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const retryLastTurn = vi.fn();
    const processBatch  = vi.fn()
      .mockRejectedValueOnce(new Error('Unexpected disk I/O failure'))
      .mockResolvedValue(0);
    const mockRuntime = { processBatch, retryLastTurn, abort: vi.fn() } as unknown as ClawRuntime;

    const { stop } = startDaemonLoop({
      runtime: mockRuntime,
      agentDir: '/tmp/non-llm-error-test',
      clawId: 'non-llm-error-test',
      inboxPendingDir: '/tmp/non-llm-error-test/inbox/pending',
      label: '[non-llm-test]',
      fallbackTimeoutMs: 500,
    });

    await flushMicrotasks();

    // Non-LLM error goes straight to waitForInbox (no retry delay)
    // retryLastTurn must never be called
    expect(retryLastTurn).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('processBatch error'),
      expect.any(Error),
    );

    stop();
    vi.advanceTimersByTime(600);
    await flushMicrotasks();
    errSpy.mockRestore();
  });
});

// ==========================================================================
// startDaemonLoop - Motion outbox scanning
// ==========================================================================

vi.mock('../../src/foundation/messaging/index.js', () => ({
  scanClawOutboxes: vi.fn(),
}));

import { scanClawOutboxes } from '../../src/foundation/messaging/index.js';

describe('startDaemonLoop - Motion outbox scanning', () => {
  beforeEach(() => {
    vi.mocked(scanClawOutboxes).mockReset();
  });

  it('isMotion=true: sends claw_outbox notification when claws have unread messages', async () => {
    vi.useFakeTimers();
    vi.mocked(scanClawOutboxes).mockResolvedValue([
      { clawId: 'claw-a', count: 3 },
      { clawId: 'claw-b', count: 1 },
    ]);

    const processBatch = vi.fn().mockResolvedValue(0);
    const mockRuntime = { processBatch, abort: vi.fn(), retryLastTurn: vi.fn() } as unknown as ClawRuntime;

    const { stop } = startDaemonLoop({
      runtime: mockRuntime,
      agentDir: '/tmp/test-motion-outbox',
      clawId: 'motion',
      inboxPendingDir: '/tmp/test-motion-outbox/inbox/pending',
      label: '[motion daemon]',
      fallbackTimeoutMs: 1_000,
      isMotion: true,
    });

    await flushMicrotasks(10);

    expect(vi.mocked(writeInboxMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'claw_outbox' }),
    );

    stop();
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();
    vi.useRealTimers();
  });

  it('isMotion=false: does not scan claw outboxes', async () => {
    vi.useFakeTimers();
    vi.mocked(scanClawOutboxes).mockResolvedValue([{ clawId: 'claw-a', count: 5 }]);

    const processBatch = vi.fn().mockResolvedValue(0);
    const mockRuntime = { processBatch, abort: vi.fn(), retryLastTurn: vi.fn() } as unknown as ClawRuntime;

    const { stop } = startDaemonLoop({
      runtime: mockRuntime,
      agentDir: '/tmp/test-claw-outbox',
      clawId: 'some-claw',
      inboxPendingDir: '/tmp/test-claw-outbox/inbox/pending',
      label: '[daemon]',
      fallbackTimeoutMs: 1_000,
      // isMotion not passed, defaults to undefined
    });

    await flushMicrotasks(10);

    expect(vi.mocked(scanClawOutboxes)).not.toHaveBeenCalled();

    stop();
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();
    vi.useRealTimers();
  });

  it('isMotion=true: no notification when no unread outbox (scanClawOutboxes returns null)', async () => {
    vi.useFakeTimers();
    vi.mocked(scanClawOutboxes).mockResolvedValue(null);
    vi.mocked(writeInboxMessage).mockReset();

    const processBatch = vi.fn().mockResolvedValue(0);
    const mockRuntime = { processBatch, abort: vi.fn(), retryLastTurn: vi.fn() } as unknown as ClawRuntime;

    const { stop } = startDaemonLoop({
      runtime: mockRuntime,
      agentDir: '/tmp/test-motion-no-outbox',
      clawId: 'motion',
      inboxPendingDir: '/tmp/test-motion-no-outbox/inbox/pending',
      label: '[motion daemon]',
      fallbackTimeoutMs: 1_000,
      isMotion: true,
    });

    await flushMicrotasks(10);

    const claw_outbox_calls = vi.mocked(writeInboxMessage).mock.calls.filter(
      ([opts]) => opts.type === 'claw_outbox'
    );
    expect(claw_outbox_calls).toHaveLength(0);

    stop();
    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();
    vi.useRealTimers();
  });
});
