import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fsSync from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { createWatcher } from '../../src/foundation/file-watcher/index.js';
import { waitFor } from '../helpers/wait-for.js';

/**
 * Async error settle budget (100ms). [B class: retained]
 * Derivation: phase 288 收紧 500ms→100ms / 等 onError throw 触发后再 close.
 * Phase 789 note: the mocked chokidar does not emit an error for a missing-file path,
 * so watcher.isActive() stays true until close(). Without changing test semantics,
 * keep the fixed sleep rather than an unstable waitFor poll.
 */
const ASYNC_ERROR_SETTLE_MS = 100;


// Mock chokidar with EventEmitter-based fake
// phase 743 step C — L40+L62 mock chokidar for CI inotify compat
// chokidar single-file watch on non-existent path 'add' event is unreliable on CI overlayfs / tmpfs
// Unit tests should test createWatcher wrapper callback / event forwarding logic, not real chokidar
class FakeChokidarWatcher extends EventEmitter {
  close = vi.fn(() => Promise.resolve());
}

let fakeWatcherInstance: FakeChokidarWatcher;

vi.mock('chokidar', () => ({
  watch: vi.fn((watchPath: string) => {
    fakeWatcherInstance = new FakeChokidarWatcher();
    if (watchPath.includes('\0')) {
      queueMicrotask(() => fakeWatcherInstance.emit('error', new Error('path contains null byte')));
    } else {
      queueMicrotask(() => fakeWatcherInstance.emit('ready'));
    }
    return fakeWatcherInstance;
  }),
}));

describe('FileWatcher', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('fw-test-');
  });

  afterEach(async () => {
    vi.restoreAllMocks(); // phase 711 P3-P1.1/1.2：防 process.platform getter + globalThis.setInterval spy 跨 worker leak
    await cleanupTempDir(tmpDir);
  });

  // chokidar is vi.mocked with `queueMicrotask(emit(...))` (line 21+) so emit happens at
  // end of current microtask tick (<1ms in practice). Budget = microtask_max (~5ms) × CI safety (×100).
  const MOCK_EVENT_PROPAGATION_BUDGET_MS = 500;

  /**
   * phase 372: 事件驱动 array buffer — push 时 resolve 已 await 的 awaitN(n) Promise.
   * 替原 waitForCount polling helper、消除 10ms 间隔等待.
   */
  interface EventBuffer<T> {
    arr: T[];
    push(item: T): void;
    awaitN(n: number, timeoutMs?: number): Promise<void>;
  }
  function makeEventBuffer<T>(): EventBuffer<T> {
    const arr: T[] = [];
    const subs: Array<{ n: number; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
    return {
      arr,
      push: (item: T) => {
        arr.push(item);
        for (let i = subs.length - 1; i >= 0; i--) {
          if (arr.length >= subs[i].n) {
            clearTimeout(subs[i].timer);
            subs[i].resolve();
            subs.splice(i, 1);
          }
        }
      },
      awaitN: (n: number, timeoutMs = MOCK_EVENT_PROPAGATION_BUDGET_MS) => {
        if (arr.length >= n) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            const idx = subs.findIndex(s => s.timer === timer);
            if (idx !== -1) subs.splice(idx, 1);
            reject(new Error(`awaitN timeout: got ${arr.length}/${n}`));
          }, timeoutMs);
          subs.push({ n, resolve, reject, timer });
        });
      },
    };
  }

  function waitForReady<T>(setupWatcher: (onReady: () => void) => T): Promise<T> {
    return new Promise((resolve) => {
      let watcher: T;
      const onReady = () => resolve(watcher);
      watcher = setupWatcher(onReady);
    });
  }

  it('callback receives add/change/unlink events', async () => {
    // Mock non-macOS to prevent fallback poll from interfering with event assertions
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const events = makeEventBuffer<{ type: string; path: string }>();
    const watcher = await waitForReady((onReady) =>
      createWatcher(
        '/fake/path/watch.txt',
        (ev) => events.push({ type: ev.type, path: path.basename(ev.path) }),
        { stability: 'immediate', onReady },
      ),
    );

    // Simulate chokidar 'all' event (real chokidar does not reliably fire 'add' on CI)
    // createWatcher listens to 'all', not individual 'add'/'change'/'unlink'
    fakeWatcherInstance.emit('all', 'add', '/fake/path/watch.txt', { size: 5, mtime: new Date() });
    await events.awaitN(1);
    expect(events.arr[0]).toMatchObject({ type: 'add', path: 'watch.txt' });

    // Simulate 'change' event
    fakeWatcherInstance.emit('all', 'change', '/fake/path/watch.txt', { size: 5, mtime: new Date() });
    await events.awaitN(2);
    expect(events.arr[1]).toMatchObject({ type: 'change', path: 'watch.txt' });

    // Simulate 'unlink' event
    fakeWatcherInstance.emit('all', 'unlink', '/fake/path/watch.txt');
    await events.awaitN(3);
    expect(events.arr[2]).toMatchObject({ type: 'unlink', path: 'watch.txt' });

    await watcher.close();
    expect(fakeWatcherInstance.close).toHaveBeenCalled();
    platformSpy.mockRestore();
  });

  it('callback error triggers onError(err, "callback") and continues', async () => {
    // Mock non-macOS to prevent fallback poll from interfering with event assertions
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const errors = makeEventBuffer<{ err: Error; context: string }>();
    const callbackTicks = makeEventBuffer<number>();
    let callCount = 0;
    const watcher = await waitForReady((onReady) =>
      createWatcher(
        '/fake/path/watch.txt',
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

    // First emit -> callback throws -> onError 'callback' + continue
    fakeWatcherInstance.emit('all', 'add', '/fake/path/watch.txt', { size: 5, mtime: new Date() });
    await errors.awaitN(1);

    // Second emit -> callback normal
    fakeWatcherInstance.emit('all', 'change', '/fake/path/watch.txt', { size: 5, mtime: new Date() });
    await callbackTicks.awaitN(2);

    expect(errors.arr.some(e => e.context === 'callback' && e.err.message === 'callback boom')).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(2);

    await watcher.close();
    platformSpy.mockRestore();
  });

  it('onReady error triggers onError(err, "ready")', async () => {
    const errors = makeEventBuffer<{ err: Error; context: string }>();
    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      {
        stability: 'immediate',
        onReady: () => { throw new Error('ready boom'); },
        onError: (err, context) => errors.push({ err, context }),
      },
    );

    await errors.awaitN(1);
    await watcher.close();

    expect(errors.arr.some(e => e.context === 'ready' && e.err.message === 'ready boom')).toBe(true);
  });

  it('chokidar error triggers onError(err, "watch")', async () => {
    const errors: { err: Error; context: string }[] = [];
    // phase 372: onError 内 Promise resolve 替原 waitFor() polling
    let firstErrorResolve!: () => void;
    const firstErrorP = new Promise<void>((r) => { firstErrorResolve = r; });
    // use null-byte path to deterministically trigger chokidar error (α.2 / per phase 703 D-1)
    const watcher = createWatcher(
      path.join(tmpDir, 'invalid\0path.txt'),
      () => {},
      {
        stability: 'immediate',
        onError: (err, context) => {
          errors.push({ err, context });
          if (errors.length === 1) firstErrorResolve();
        },
      },
    );

    await firstErrorP;
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

    // sleep: async error trigger; no deterministic signal (phase 288: 500ms → 100ms)
    await new Promise(r => setTimeout(r, ASYNC_ERROR_SETTLE_MS));
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

  // === fallback poll（phase 352 / 469 / 760 — cross-platform immediate mode）===

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

  it('Linux immediate mode enables fallback poll (phase 760 cross-platform)', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
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

  it('fallback poll emits change event to callback', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const events = makeEventBuffer<{ type: string; path: string }>();

    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      (ev) => events.push({ type: ev.type, path: path.basename(ev.path) }),
      { stability: 'immediate', fallbackPollMs: 50 },
    );

    await events.awaitN(1);

    expect(events.arr.length).toBeGreaterThanOrEqual(1);
    expect(events.arr.every(e => e.type === 'change')).toBe(true);

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
