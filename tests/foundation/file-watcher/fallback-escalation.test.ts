import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWatcher } from '../../../src/foundation/file-watcher/index.js';
import path from 'node:path';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';

/**
 * Test-local expectation for the watcher-internal fallback escalation threshold.
 * The constant is an implementation detail of watcher.ts (not exported); the public
 * contract ratchet pins its value at 5.
 */
const EXPECTED_ESCALATION_FAILURE_COUNT = 5;

/**
 * Fallback poller 加速 poll interval（test 内）— 注入 createWatcher 让 fallback 路径 10ms tick.
 * Derivation: 10ms << EXPECTED_ESCALATION_FAILURE_COUNT (5) × prod default poll (500ms) = 2500ms /
 * 比 prod default (500ms) 快 50× 加速 test / phase 372 后 wait budget 已由 Promise event 替代.
 */
const FAST_POLL_MS = 10;

/**
 * Reset observation poll count — 测 fallback reset 后再观察 N 次 poll 内不再 escalate.
 * Derivation: 10 = 给 reset 后 stable 状态足够 sample.
 */
const RESET_OBSERVATION_POLL_COUNT = 10;

describe('fallback poller escalation', () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fallback-test-'));
    testFile = path.join(tmpDir, 'test.txt');
    writeFileSync(testFile, '');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    'escalates after 5 consecutive callback failures and keeps polling',
    async () => {
      const errors: Array<{ err: Error; context: string }> = [];
      // phase 372: callback 内 Promise resolve hook 替原 waitFor() polling
      let nextCallAfterLimitResolve: (() => void) | null = null;
      const callback = vi.fn(() => {
        if (nextCallAfterLimitResolve) {
          nextCallAfterLimitResolve();
          nextCallAfterLimitResolve = null;
        }
        throw new Error('forced callback failure');
      });

      let fallbackLimitResetResolve!: () => void;
      const fallbackLimitResetP = new Promise<void>((r) => { fallbackLimitResetResolve = r; });
      const watcher = createWatcher(testFile, callback, {
        stability: 'immediate',
        fallbackPollMs: FAST_POLL_MS,
        onError: (err, context) => {
          errors.push({ err, context });
          if (context === 'fallback_limit_reset') fallbackLimitResetResolve();
        },
      });

      await fallbackLimitResetP;

      expect(callback).toHaveBeenCalledTimes(EXPECTED_ESCALATION_FAILURE_COUNT);

      // Assert escalation
      const fallbackLimitReset = errors.find(e => e.context === 'fallback_limit_reset');
      expect(fallbackLimitReset, 'expected fallback_limit_reset context').toBeDefined();
      expect(fallbackLimitReset!.err.message).toMatch(/callback failure limit reached/);

      // phase 1082: poller is NOT permanently disabled — it resets counter and continues.
      // phase 372: Promise hook 模式等下次 callback call
      const countAtLimit = callback.mock.calls.length;
      const nextCallAfterLimitP = new Promise<void>((r) => { nextCallAfterLimitResolve = r; });
      await nextCallAfterLimitP;
      expect(callback.mock.calls.length).toBeGreaterThan(countAtLimit);

      // Stop watcher (clearInterval again is no-op-safe)
      await watcher.close();
    },
  );

  // phase 1128 P1-5: async callback rejection must be observed and increment fail counter
  it(
    'fallback poller: async callback rejection is observed (no unhandled rejection) + increments consecutiveCallbackFails',
    async () => {
      const errors: Array<{ err: Error; context: string }> = [];
      let callCount = 0;
      let afterLimitResolve: (() => void) | null = null;
      const afterLimitP = new Promise<void>((r) => { afterLimitResolve = r; });

      const callback = vi.fn(async () => {
        callCount++;
        if (callCount >= EXPECTED_ESCALATION_FAILURE_COUNT + 2 && afterLimitResolve) {
          afterLimitResolve();
          afterLimitResolve = null;
        }
        throw new Error('async forced callback failure');
      });

      let fallbackLimitResetResolve!: () => void;
      const fallbackLimitResetP = new Promise<void>((r) => { fallbackLimitResetResolve = r; });

      const watcher = createWatcher(testFile, callback, {
        stability: 'immediate',
        fallbackPollMs: FAST_POLL_MS,
        onError: (err, context) => {
          errors.push({ err, context });
          if (context === 'fallback_limit_reset') fallbackLimitResetResolve();
        },
      });

      await fallbackLimitResetP;
      await afterLimitP;
      await watcher.close();

      const callbackErrors = errors.filter(e => e.context === 'callback');
      expect(callbackErrors.length).toBeGreaterThanOrEqual(EXPECTED_ESCALATION_FAILURE_COUNT);
      expect(callbackErrors[0].err.message).toBe('async forced callback failure');

      const fallbackLimitReset = errors.find(e => e.context === 'fallback_limit_reset');
      expect(fallbackLimitReset, 'expected fallback_limit_reset context').toBeDefined();
      expect(fallbackLimitReset!.err.message).toMatch(/callback failure limit reached/);
    },
  );

  // phase 1128 P1-5: consecutive async failures must reach limit and trigger escalation
  it(
    'fallback poller: consecutive async failures reach limit → fallback_limit_reset onError',
    async () => {
      const errors: Array<{ err: Error; context: string }> = [];
      let fallbackLimitResetResolve!: () => void;
      const fallbackLimitResetP = new Promise<void>((r) => { fallbackLimitResetResolve = r; });

      const callback = vi.fn(async () => {
        throw new Error('consecutive async failure');
      });

      const watcher = createWatcher(testFile, callback, {
        stability: 'immediate',
        fallbackPollMs: FAST_POLL_MS,
        onError: (err, context) => {
          errors.push({ err, context });
          if (context === 'fallback_limit_reset') fallbackLimitResetResolve();
        },
      });

      await fallbackLimitResetP;
      await watcher.close();

      const callbackErrors = errors.filter(e => e.context === 'callback');
      expect(callbackErrors.length).toBeGreaterThanOrEqual(EXPECTED_ESCALATION_FAILURE_COUNT);
      const fallbackLimitReset = errors.find(e => e.context === 'fallback_limit_reset');
      expect(fallbackLimitReset).toBeDefined();
      expect(fallbackLimitReset!.err.message).toMatch(/callback failure limit reached/);
    },
  );

  it(
    'resets counter on successful callback',
    async () => {
      let throwCount = 0;
      const errors: Array<{ err: Error; context: string }> = [];
      // phase 372: callback 内 Promise resolve hook 替原 waitFor() polling
      let tenCallsResolve!: () => void;
      const tenCallsP = new Promise<void>((r) => { tenCallsResolve = r; });
      const callback = vi.fn(() => {
        throwCount++;
        if (callback.mock.calls.length >= RESET_OBSERVATION_POLL_COUNT) tenCallsResolve();
        if (throwCount < EXPECTED_ESCALATION_FAILURE_COUNT) throw new Error('intermittent fail');
        // success after 4 failures (below the escalation threshold)
      });

      const watcher = createWatcher(testFile, callback, {
        stability: 'immediate',
        fallbackPollMs: FAST_POLL_MS,
        onError: (err, context) => {
          errors.push({ err, context });
        },
      });

      await tenCallsP;
      await watcher.close();

      const fallbackLimitReset = errors.find(e => e.context === 'fallback_limit_reset');
      expect(fallbackLimitReset).toBeUndefined(); // no escalation
    },
  );
});
