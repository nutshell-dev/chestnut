import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { createWatcher } from '../../../src/foundation/file-watcher/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const ABSENT_STORM_POLL_COUNT = 100;

describe('fallback absent target storm guard', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('fw-absent-storm-');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tmpDir);
  });

  it('absent target over 100 fallback ticks emits no callback or error', async () => {
    let tick: (() => Promise<void>) | null = null;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler) => {
      tick = handler as () => Promise<void>;
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    });
    const callback = vi.fn();
    const onError = vi.fn();
    const watcher = createWatcher(path.join(tmpDir, 'missing-interrupt'), callback, {
      stability: 'immediate',
      onError,
    });

    try {
      if (tick === null) throw new Error('fallback timer was not registered');
      for (let i = 0; i < ABSENT_STORM_POLL_COUNT; i++) {
        await tick();
      }
      expect(callback).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await watcher.close();
    }
  });
});
