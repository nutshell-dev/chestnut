import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWatcher } from '../../../src/foundation/file-watcher/index.js';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';

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

      // Wait for ≥ 6 polls (5 fails + 1 disable trigger; allow buffer)
      await new Promise(r => setTimeout(r, 100));

      // Stop watcher (clearInterval again is no-op-safe)
      await watcher.close();

      // Assert escalation
      const fallbackDisabled = errors.find(e => e.context === 'fallback_disabled');
      expect(fallbackDisabled, 'expected fallback_disabled context').toBeDefined();
      expect(fallbackDisabled!.err.message).toMatch(/disabled after 5 consecutive callback failures/);

      // Assert poller stopped: callback count plateaus
      const countAtDisable = callback.mock.calls.length;
      await new Promise(r => setTimeout(r, 50));
      expect(callback.mock.calls.length).toBe(countAtDisable); // no further calls
    },
  );

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

      // Wait > 10 polls (3 fail + many success / counter should reset / no escalation)
      await new Promise(r => setTimeout(r, 200));
      await watcher.close();

      const fallbackDisabled = errors.find(e => e.context === 'fallback_disabled');
      expect(fallbackDisabled).toBeUndefined(); // no escalation
    },
  );
});
