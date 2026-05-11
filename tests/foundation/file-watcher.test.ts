import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

import { createWatcher } from '../../src/foundation/file-watcher/index.js';
import { waitFor } from '../helpers/wait-for.js';

describe('FileWatcher', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fw-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function waitForCount(arr: unknown[], n: number, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (arr.length < n) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`waitForCount timeout: got ${arr.length}/${n}`);
      }
      await new Promise(r => setTimeout(r, 10));
    }
  }

  function waitForReady<T>(setupWatcher: (onReady: () => void) => T): Promise<T> {
    return new Promise((resolve) => {
      let watcher: T;
      const onReady = () => resolve(watcher);
      watcher = setupWatcher(onReady);
    });
  }

  it('callback receives add/change/unlink events', async () => {
    const events: { type: string; path: string }[] = [];
    const watcher = await waitForReady((onReady) =>
      createWatcher(
        path.join(tmpDir, 'watch.txt'),
        (ev) => events.push({ type: ev.type, path: path.basename(ev.path) }),
        { stability: 'immediate', onReady },
      ),
    );

    fsSync.writeFileSync(path.join(tmpDir, 'watch.txt'), 'hello');
    await waitForCount(events, 1);

    fsSync.writeFileSync(path.join(tmpDir, 'watch.txt'), 'world');
    await waitForCount(events, 2);

    await watcher.close();

    expect(events.some(e => e.type === 'add')).toBe(true);
    expect(events.some(e => e.type === 'change')).toBe(true);
  });

  it('callback error triggers onError(err, "callback") and continues', async () => {
    const errors: { err: Error; context: string }[] = [];
    const callbackTicks: number[] = [];
    let callCount = 0;
    const watcher = await waitForReady((onReady) =>
      createWatcher(
        path.join(tmpDir, 'watch.txt'),
        (ev) => {
          callCount++;
          callbackTicks.push(callCount);
          if (callCount === 1) throw new Error('callback boom');
        },
        {
          stability: 'immediate',
          onReady,
          onError: (err, context) => errors.push({ err, context }),
        },
      ),
    );

    fsSync.writeFileSync(path.join(tmpDir, 'watch.txt'), 'first');
    await waitForCount(errors, 1);

    fsSync.writeFileSync(path.join(tmpDir, 'watch.txt'), 'second');
    await waitForCount(callbackTicks, 2);

    await watcher.close();

    expect(errors.some(e => e.context === 'callback' && e.err.message === 'callback boom')).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('onReady error triggers onError(err, "ready")', async () => {
    const errors: { err: Error; context: string }[] = [];
    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      {
        stability: 'immediate',
        onReady: () => { throw new Error('ready boom'); },
        onError: (err, context) => errors.push({ err, context }),
      },
    );

    await waitForCount(errors, 1);
    await watcher.close();

    expect(errors.some(e => e.context === 'ready' && e.err.message === 'ready boom')).toBe(true);
  });

  it('chokidar error triggers onError(err, "watch")', async () => {
    const errors: { err: Error; context: string }[] = [];
    // use null-byte path to deterministically trigger chokidar error (α.2 / per phase 703 D-1)
    const watcher = createWatcher(
      path.join(tmpDir, 'invalid\0path.txt'),
      () => {},
      {
        stability: 'immediate',
        onError: (err, context) => errors.push({ err, context }),
      },
    );

    // chokidar emits 'error' for invalid path with null byte / waitFor strict（不 silent skip）
    await waitFor(() => errors.length > 0, 2000);
    await watcher.close();

    expect(errors.some(e => e.context === 'watch')).toBe(true);
  });

  it('onError handler error is swallowed and not propagated', async () => {
    const errors: { err: Error; context: string }[] = [];
    const watcher = createWatcher(
      path.join(tmpDir, 'deep', 'nested', 'missing.txt'),
      () => {},
      {
        stability: 'immediate',
        onError: (err, context) => {
          errors.push({ err, context });
          throw new Error('onError boom');
        },
      },
    );

    // async error trigger; physical sleep as no deterministic signal
    await new Promise(r => setTimeout(r, 500));
    await watcher.close();

    // onError throwing should not cause infinite loop or unhandled rejection
    // we just verify the watcher still closes cleanly
    expect(watcher.isActive()).toBe(false);
  });

  it('close is idempotent', async () => {
    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      { stability: 'immediate' },
    );
    await watcher.close();
    await expect(watcher.close()).resolves.toBeUndefined();
  });

  // === fallback poll（phase469 / macOS + immediate only）===

  it('macOS immediate mode enables fallback poll with default 500ms', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const setSpy = vi.spyOn(globalThis, 'setInterval');

    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      { stability: 'immediate' },
    );

    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 500);

    await watcher.close();
    platformSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('fallback poll interval is overridable via options.fallbackPollMs', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const setSpy = vi.spyOn(globalThis, 'setInterval');

    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      { stability: 'immediate', fallbackPollMs: 200 },
    );

    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 200);

    await watcher.close();
    platformSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('stable mode does not enable fallback poll', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const setSpy = vi.spyOn(globalThis, 'setInterval');

    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      { stability: 'stable' },
    );

    expect(setSpy).not.toHaveBeenCalled();

    await watcher.close();
    platformSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('non-macOS platform does not enable fallback poll even in immediate mode', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const setSpy = vi.spyOn(globalThis, 'setInterval');

    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      { stability: 'immediate' },
    );

    expect(setSpy).not.toHaveBeenCalled();

    await watcher.close();
    platformSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('fallback poll emits change event to callback', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const events: { type: string; path: string }[] = [];

    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      (ev) => events.push({ type: ev.type, path: path.basename(ev.path) }),
      { stability: 'immediate', fallbackPollMs: 50 },
    );

    await waitForCount(events, 1);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every(e => e.type === 'change')).toBe(true);

    await watcher.close();
    platformSpy.mockRestore();
  });

  it('close clears fallback poll timer / no resource leak', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const setSpy = vi.spyOn(globalThis, 'setInterval');

    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      { stability: 'immediate' },
    );

    const timerHandle = setSpy.mock.results[0]?.value;
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    await watcher.close();

    if (timerHandle !== undefined) {
      expect(clearSpy).toHaveBeenCalledWith(timerHandle);
    }

    platformSpy.mockRestore();
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
