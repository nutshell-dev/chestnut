import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWatcher } from '../../../src/foundation/file-watcher/index.js';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { waitFor } from '../../helpers/wait-for.js';

describe('fallback poller escalation (macOS only)', () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fallback-test-'));
    testFile = path.join(tmpDir, 'test.txt');
    writeFileSync(testFile, '');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // skipIf rationale: chokidar fallback poller is only enabled on macOS FSEvents path
  // when stability === 'immediate' (per src/foundation/file-watcher/watcher.ts comment).
  // Linux inotify + Windows ReadDirectoryChangesW do not use the fallback poller,
  // so escalation cannot be exercised on those platforms by design — not a coverage gap.
  it.skipIf(process.platform !== 'darwin')(
    'disables poller after 5 consecutive callback failures',
    async () => {
      const errors: Array<{ err: Error; context: string }> = [];
      const callback = vi.fn(() => {
        throw new Error('forced callback failure');
      });

      const watcher = createWatcher(testFile, callback, {
        stability: 'immediate',
        fallbackPollMs: 10, // fast poll for test
        onError: (err, context) => {
          errors.push({ err, context });
        },
      });

      // Wait for fallback_disabled context (replaces fixed setTimeout(100)).
      await waitFor(
        () => errors.some(e => e.context === 'fallback_disabled'),
        5000,
        10,
      );

      // Stop watcher (clearInterval again is no-op-safe)
      await watcher.close();

      // Assert escalation
      const fallbackDisabled = errors.find(e => e.context === 'fallback_disabled');
      expect(fallbackDisabled, 'expected fallback_disabled context').toBeDefined();
      expect(fallbackDisabled!.err.message).toMatch(/disabled after 5 consecutive callback failures/);

      // Plateau check (NEGATIVE assertion: no further callback calls after disable).
      // Intentional fixed wait — there is no positive state change to poll for.
      // 200ms = 20× fallbackPollMs; if poller still alive, would accumulate ≥10 extra calls.
      const countAtDisable = callback.mock.calls.length;
      await new Promise(r => setTimeout(r, 200));
      expect(callback.mock.calls.length).toBe(countAtDisable);
    },
  );

  // (Same darwin-only rationale as above)
  it.skipIf(process.platform !== 'darwin')(
    'resets counter on successful callback',
    async () => {
      let throwCount = 0;
      const errors: Array<{ err: Error; context: string }> = [];
      const callback = vi.fn(() => {
        throwCount++;
        if (throwCount <= 3) throw new Error('intermittent fail');
        // success after 3 fails
      });

      const watcher = createWatcher(testFile, callback, {
        stability: 'immediate',
        fallbackPollMs: 10,
        onError: (err, context) => {
          errors.push({ err, context });
        },
      });

      // Wait until ≥10 polls have run (3 fails + ≥7 successes — counter must reset).
      await waitFor(
        () => callback.mock.calls.length >= 10,
        5000,
        10,
      );
      await watcher.close();

      const fallbackDisabled = errors.find(e => e.context === 'fallback_disabled');
      expect(fallbackDisabled).toBeUndefined(); // no escalation
    },
  );
});
