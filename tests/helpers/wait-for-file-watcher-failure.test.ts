import { writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForPathExists, waitForPathGone } from './wait-for-file.js';
import type {
  WatcherErrorContext,
  WatcherFactory,
  WatchEvent,
} from '../../src/foundation/file-watcher/types.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

interface WatchHarness {
  factory: WatcherFactory;
  emitError(error: Error, context?: WatcherErrorContext): void;
  emit(event: WatchEvent): void;
  emitReady(): void;
  releaseClose(error?: Error): void;
  closeCalls(): number;
  created: Promise<void>;
}

function createWatchHarness(): WatchHarness {
  let callback: ((event: WatchEvent) => void) | undefined;
  let onError: ((error: Error, context: WatcherErrorContext) => void) | undefined;
  let onReady: (() => void) | undefined;
  let closeCount = 0;
  let finishClose: ((error?: Error) => void) | undefined;
  let resolveCreated: (() => void) | undefined;

  const closePromise = new Promise<void>((resolve, reject) => {
    finishClose = (error) => (error ? reject(error) : resolve());
  });
  closePromise.catch(() => { /* handled by consumer */ });

  const created = new Promise<void>((resolve) => {
    resolveCreated = resolve;
  });

  return {
    factory: (_watchPath, nextCallback, options) => {
      callback = nextCallback;
      onError = options?.onError;
      onReady = options?.onReady;
      resolveCreated?.();
      return {
        close: () => {
          closeCount++;
          return closePromise;
        },
        isActive: () => true,
        getPath: () => _watchPath,
      };
    },
    emitError: (error, context = 'watch') => {
      if (!onError) throw new Error('onError was not registered');
      onError(error, context);
    },
    emit: (event) => {
      if (!callback) throw new Error('callback was not registered');
      callback(event);
    },
    emitReady: () => {
      if (onReady) onReady();
    },
    releaseClose: (error) => {
      if (!finishClose) throw new Error('close deferred was not initialized');
      finishClose(error);
    },
    closeCalls: () => closeCount,
    created,
  };
}

describe('waitForPathExists watcher fatal barrier', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('wf-exists-');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('rejects with watch error only after close resolves (Exists)', async () => {
    const harness = createWatchHarness();
    const targetPath = path.join(tempDir, 'missing.txt');
    const watchError = new Error('watch failed');

    const promise = waitForPathExists(targetPath, 5000, { watcherFactory: harness.factory });
    await harness.created;

    let settled = false;
    let rejection: unknown;
    const observed = promise.then(
      () => {
        settled = true;
      },
      (err) => {
        settled = true;
        rejection = err;
      },
    );

    harness.emitError(watchError, 'watch');

    // Before close is released, the promise must still be pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(settledOrPending(settled)).toBe('pending');
    expect(harness.closeCalls()).toBe(1);

    harness.releaseClose();
    await observed;

    expect(settled).toBe(true);
    expect(rejection).toBe(watchError);
    expect(harness.closeCalls()).toBe(1);
  });
});

describe('waitForPathGone watcher fatal barrier', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('wf-gone-');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('rejects with watch error only after close resolves (Gone)', async () => {
    const harness = createWatchHarness();
    const targetPath = path.join(tempDir, 'present.txt');
    await writeFile(targetPath, 'x');
    const watchError = new Error('watch failed');

    const promise = waitForPathGone(targetPath, 5000, { watcherFactory: harness.factory });
    await harness.created;

    let settled = false;
    let rejection: unknown;
    const observed = promise.then(
      () => {
        settled = true;
      },
      (err) => {
        settled = true;
        rejection = err;
      },
    );

    harness.emitError(watchError, 'watch');

    await Promise.resolve();
    await Promise.resolve();
    expect(settledOrPending(settled)).toBe('pending');
    expect(harness.closeCalls()).toBe(1);

    harness.releaseClose();
    await observed;

    expect(settled).toBe(true);
    expect(rejection).toBe(watchError);
    expect(harness.closeCalls()).toBe(1);
  });
});

describe('watch barrier cleanup outcome matrix', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('wf-matrix-');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('Exists success + close failure rejects with cleanup error', async () => {
    const harness = createWatchHarness();
    const targetPath = path.join(tempDir, 'appears.txt');
    const closeError = new Error('close failed');

    const promise = waitForPathExists(targetPath, 5000, { watcherFactory: harness.factory });
    await harness.created;

    harness.emitReady();
    // simulate the file actually appearing on disk before emitting event
    await writeFile(targetPath, 'data');
    harness.emit({ type: 'add', path: targetPath });

    // Release close with failure
    harness.releaseClose(closeError);

    await expect(promise).rejects.toBe(closeError);
    expect(harness.closeCalls()).toBe(1);
  });

  it('fatal watch + close both fail rejects AggregateError with ordered errors', async () => {
    const harness = createWatchHarness();
    const targetPath = path.join(tempDir, 'missing.txt');
    const watchError = new Error('watch failed');
    const closeError = new Error('close failed');

    const promise = waitForPathExists(targetPath, 5000, { watcherFactory: harness.factory });
    await harness.created;

    harness.emitError(watchError, 'watch');
    harness.releaseClose(closeError);

    await promise.then(
      () => {
        throw new Error('expected promise to reject');
      },
      (err) => {
        expect(err).toBeInstanceOf(AggregateError);
        const agg = err as AggregateError;
        expect(agg.errors).toHaveLength(2);
        expect(agg.errors[0]).toBe(watchError);
        expect(agg.errors[1]).toBe(closeError);
      },
    );
    expect(harness.closeCalls()).toBe(1);
  });

  it('first winner wins: fatal then another event does not change outcome', async () => {
    const harness = createWatchHarness();
    const targetPath = path.join(tempDir, 'missing.txt');
    const watchError = new Error('watch failed');
    const secondError = new Error('second watch error');

    const promise = waitForPathExists(targetPath, 5000, { watcherFactory: harness.factory });
    await harness.created;

    harness.emitError(watchError, 'watch');
    harness.emitError(secondError, 'watch');
    harness.emit({ type: 'add', path: targetPath });
    harness.releaseClose();

    await expect(promise).rejects.toBe(watchError);
    expect(harness.closeCalls()).toBe(1);
  });

  it('fallback_limit_reset context does not settle; subsequent watch error does', async () => {
    const harness = createWatchHarness();
    const targetPath = path.join(tempDir, 'missing.txt');
    const recoverable = new Error('fallback limit reset');
    const watchError = new Error('watch failed');

    const promise = waitForPathExists(targetPath, 5000, { watcherFactory: harness.factory });
    await harness.created;

    harness.emitError(recoverable, 'fallback_limit_reset');

    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(settledOrPending(settled)).toBe('pending');
    expect(harness.closeCalls()).toBe(0);

    harness.emitError(watchError, 'watch');
    harness.releaseClose();

    await expect(promise).rejects.toBe(watchError);
    expect(harness.closeCalls()).toBe(1);
  });

  it('factory synchronously emits onError before returning handle: close still called once', async () => {
    let closeCount = 0;
    let finishClose: ((error?: Error) => void) | undefined;
    let factoryCalled: (() => void) | undefined;
    const factoryCreated = new Promise<void>((resolve) => {
      factoryCalled = resolve;
    });
    const closePromise = new Promise<void>((resolve, reject) => {
      finishClose = (error) => (error ? reject(error) : resolve());
    });
    const watchError = new Error('watch failed at construction');
    const targetPath = path.join(tempDir, 'missing.txt');

    const factory: WatcherFactory = (_watchPath, _callback, options) => {
      options?.onError?.(watchError, 'watch');
      factoryCalled?.();
      return {
        close: () => {
          closeCount++;
          return closePromise;
        },
        isActive: () => true,
        getPath: () => _watchPath,
      };
    };

    const promise = waitForPathExists(targetPath, 5000, { watcherFactory: factory });
    await factoryCreated;
    await Promise.resolve();
    await Promise.resolve();
    expect(closeCount).toBe(1);

    finishClose?.();
    await expect(promise).rejects.toBe(watchError);
    expect(closeCount).toBe(1);
  });
});

describe('watch barrier normal behavior', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('wf-normal-');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('Exists: resolves after add event and close completes', async () => {
    const harness = createWatchHarness();
    const targetPath = path.join(tempDir, 'appears.txt');

    const promise = waitForPathExists(targetPath, 5000, { watcherFactory: harness.factory });
    await harness.created;

    await writeFile(targetPath, 'data');
    harness.emit({ type: 'add', path: targetPath });
    harness.releaseClose();

    await promise;
    expect(harness.closeCalls()).toBe(1);
  });

  it('Gone: resolves after unlink event and close completes', async () => {
    const harness = createWatchHarness();
    const targetPath = path.join(tempDir, 'disappears.txt');
    await writeFile(targetPath, 'x');

    const promise = waitForPathGone(targetPath, 5000, { watcherFactory: harness.factory });
    await harness.created;

    await rm(targetPath, { force: true });
    harness.emit({ type: 'unlink', path: targetPath });
    harness.releaseClose();

    await promise;
    expect(harness.closeCalls()).toBe(1);
  });

  it('Exists: initial check returns immediately without calling factory or close', async () => {
    const harness = createWatchHarness();
    const targetPath = path.join(tempDir, 'already.txt');
    await writeFile(targetPath, 'x');

    await waitForPathExists(targetPath, 5000, { watcherFactory: harness.factory });
    expect(harness.closeCalls()).toBe(0);
  });

  it('Gone: initial check returns immediately without calling factory or close', async () => {
    const harness = createWatchHarness();
    const targetPath = path.join(tempDir, 'already-gone.txt');

    await waitForPathGone(targetPath, 5000, { watcherFactory: harness.factory });
    expect(harness.closeCalls()).toBe(0);
  });
});

function settledOrPending(settled: boolean): 'settled' | 'pending' {
  return settled ? 'settled' : 'pending';
}
