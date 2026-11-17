import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fsSync from 'fs';
import { promises as fsPromises } from 'node:fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { watch as chokidarWatch } from 'chokidar';
import { createWatcher } from '../../src/foundation/file-watcher/index.js';
import { waitFor } from '../helpers/wait-for.js';

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

  function captureFallbackTick(): () => Promise<void> {
    let tick: (() => Promise<void>) | null = null;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler) => {
      tick = handler as () => Promise<void>;
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    });
    return async () => {
      if (tick === null) throw new Error('fallback timer was not registered');
      await tick();
    };
  }

  it('callback receives add/change/unlink events', async () => {
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
  });

  it('callback error triggers onError(err, "callback") and continues', async () => {
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
  });

  it.each([
    { mode: 'sync throw', callback: () => { throw new Error('primary'); } },
    { mode: 'async rejection', callback: async () => { throw new Error('primary'); } },
  ])('callback $mode without onError is observable and preserves watcher lifecycle', async ({ callback }) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const watcher = createWatcher('/fake/watch.txt', callback, { stability: 'immediate' });

    fakeWatcherInstance.emit('all', 'change', '/fake/watch.txt', { size: 1, mtime: new Date() });
    await waitFor(() => consoleError.mock.calls.length === 1);

    expect(String(consoleError.mock.calls[0]?.[0]))
      .toContain('[file-watcher] callback failure: primary');
    expect(watcher.isActive()).toBe(true);
    await watcher.close();
    expect(watcher.isActive()).toBe(false);
    await expect(watcher.close()).resolves.toBeUndefined();
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

  it('ready error with a throwing onError preserves primary and secondary failures', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const errors: { err: Error; context: string }[] = [];
    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      {
        stability: 'immediate',
        onReady: () => { throw new Error('ready primary'); },
        onError: (err, context) => {
          errors.push({ err, context });
          throw new Error('ready sink');
        },
      },
    );

    await waitFor(() => stderrWrite.mock.calls.length === 1);
    const fallback = String(stderrWrite.mock.calls[0]?.[0]);
    expect(fallback).toContain('context=ready');
    expect(fallback).toContain('sink=ready sink');
    expect(fallback).toContain('primary=ready primary');
    expect(errors).toEqual([{ err: expect.any(Error), context: 'ready' }]);
    expect(watcher.isActive()).toBe(true);
    await watcher.close();
    expect(watcher.isActive()).toBe(false);
    await expect(watcher.close()).resolves.toBeUndefined();
  });

  it('watch error with a throwing onError preserves context and separates health from release', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const watcher = createWatcher('/fake/watch.txt', () => {}, {
      stability: 'immediate',
      onError: () => { throw new Error('watch sink'); },
    });

    fakeWatcherInstance.emit('error', new Error('watch primary'));

    expect(watcher.isActive()).toBe(false);
    const fallback = String(stderrWrite.mock.calls[0]?.[0]);
    expect(fallback).toContain('context=watch');
    expect(fallback).toContain('sink=watch sink');
    expect(fallback).toContain('primary=watch primary');
    await watcher.close();
    expect(fakeWatcherInstance.close).toHaveBeenCalledTimes(1);
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

  // === phase 1372: fatal error 后 health 态与 release 态分离 ===

  it('fatal error disables subscription but close releases the underlying watcher exactly once', async () => {
    const errors: Error[] = [];
    const watcher = createWatcher('/fake/watch.txt', () => {}, {
      stability: 'immediate',
      onError: (err, context) => {
        if (context === 'watch') errors.push(err);
      },
    });

    fakeWatcherInstance.emit('error', new Error('watch failed'));
    expect(watcher.isActive()).toBe(false);

    const first = watcher.close();
    const second = watcher.close();
    await Promise.all([first, second]);

    expect(errors.map(err => err.message)).toContain('watch failed');
    expect(fakeWatcherInstance.close).toHaveBeenCalledTimes(1);
  });

  it('fatal error does not skip fallback timer cleanup on close', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');

    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      { stability: 'immediate' },
    );

    const timerHandle = setSpy.mock.results[0]?.value;
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    fakeWatcherInstance.emit('error', new Error('watch failed'));
    expect(watcher.isActive()).toBe(false);

    await watcher.close();

    expect(timerHandle).toBeDefined();
    expect(clearSpy).toHaveBeenCalledWith(timerHandle);
    expect(fakeWatcherInstance.close).toHaveBeenCalledTimes(1);
  });

  it('concurrent close callers observe the same underlying rejection', async () => {
    const closeError = new Error('close failed');
    const watcher = createWatcher('/fake/watch.txt', () => {});
    // 必须在 createWatcher 之后配置：mock watch 工厂每次创建新 fakeWatcherInstance
    fakeWatcherInstance.close.mockRejectedValueOnce(closeError);

    const first = watcher.close();
    const second = watcher.close();

    // 先挂 rejection 断言、防 RED 态（fix 前 second 不 reject）产生 unhandled rejection
    const firstRejection = expect(first).rejects.toBe(closeError);
    const secondRejection = expect(second).rejects.toBe(closeError);
    expect(first).toBe(second);
    await Promise.all([firstRejection, secondRejection]);
    expect(fakeWatcherInstance.close).toHaveBeenCalledTimes(1);
  });

  // === fallback poll（phase 352 / 469 / 760 — cross-platform immediate mode）===

  it('immediate mode enables fallback poll with default 500ms', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');

    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      { stability: 'immediate' },
    );

    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 500);

    await watcher.close();
    setSpy.mockRestore();
  });

  it('fallback poll interval is overridable via options.fallbackPollMs', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');

    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      { stability: 'immediate', fallbackPollMs: 200 },
    );

    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 200);

    await watcher.close();
    setSpy.mockRestore();
  });

  it('stable mode does not enable fallback poll', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');

    const watcher = createWatcher(
      path.join(tmpDir, 'watch.txt'),
      () => {},
      { stability: 'stable' },
    );

    expect(setSpy).not.toHaveBeenCalled();

    await watcher.close();
    setSpy.mockRestore();
  });

  it('stable mode configures chokidar with the 100ms/50ms stability window', async () => {
    vi.mocked(chokidarWatch).mockClear();
    const watcher = createWatcher('/fake/watch.txt', () => {}, { stability: 'stable' });

    expect(vi.mocked(chokidarWatch)).toHaveBeenCalledWith(
      '/fake/watch.txt',
      expect.objectContaining({
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 50,
        },
      }),
    );

    await watcher.close();
  });

  it.each(['darwin', 'linux', 'win32'])(
    'immediate mode creates fallback timer on %s (phase 760 cross-platform)',
    async (platform) => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform);
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
    },
  );

  it('fallback poll emits only real add/change transitions', async () => {
    const events: { type: string; path: string }[] = [];
    const watchedPath = path.join(tmpDir, 'watch.txt');
    const tick = captureFallbackTick();
    const watcher = createWatcher(
      watchedPath,
      (ev) => { events.push({ type: ev.type, path: path.basename(ev.path) }); },
      { stability: 'immediate' },
    );

    // Write before the first async tick: the construction-time baseline must preserve it.
    fsSync.writeFileSync(watchedPath, 'a');
    await tick(); // absent -> present
    await tick(); // unchanged
    fsSync.writeFileSync(watchedPath, 'changed');
    await tick(); // size change
    fsSync.rmSync(watchedPath);
    await tick(); // present -> absent is not a synthetic change
    fsSync.writeFileSync(watchedPath, 'recreated');
    await tick(); // absent -> present again
    await tick(); // unchanged

    await watcher.close();
    expect(events).toEqual([
      { type: 'add', path: 'watch.txt' },
      { type: 'change', path: 'watch.txt' },
      { type: 'add', path: 'watch.txt' },
    ]);
  });

  it('native events update the fallback baseline without a duplicate fallback event', async () => {
    const events: string[] = [];
    const watchedPath = path.join(tmpDir, 'watch.txt');
    fsSync.writeFileSync(watchedPath, 'initial');
    const tick = captureFallbackTick();
    const watcher = createWatcher(
      watchedPath,
      (ev) => { events.push(ev.type); },
      { stability: 'immediate' },
    );

    await tick(); // initial present baseline
    fsSync.writeFileSync(watchedPath, 'native change');
    fakeWatcherInstance.emit('all', 'change', watchedPath, fsSync.statSync(watchedPath));
    await tick();

    await watcher.close();
    expect(events).toEqual(['change']);
  });

  it('fallback probe failure preserves fallback_probe context and is not a change', async () => {
    const events: string[] = [];
    const errors: { err: Error; context: string }[] = [];
    const watchedPath = path.join(tmpDir, 'watch.txt');
    const probeError = new Error('permission denied') as NodeJS.ErrnoException;
    probeError.code = 'EACCES';
    vi.spyOn(fsPromises, 'stat').mockRejectedValueOnce(probeError);
    const tick = captureFallbackTick();
    const watcher = createWatcher(
      watchedPath,
      (ev) => { events.push(ev.type); },
      {
        stability: 'immediate',
        onError: (err, context) => { errors.push({ err, context }); },
      },
    );

    await tick(); // failed probe keeps the previous baseline and emits nothing
    await tick(); // initial absent baseline after recovery
    fsSync.writeFileSync(watchedPath, 'created');
    await tick();

    await watcher.close();
    expect(errors).toEqual([{ err: probeError, context: 'fallback_probe' }]);
    expect(events).toEqual(['add']);
  });

  it('close clears fallback poll timer / no resource leak', async () => {
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

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
