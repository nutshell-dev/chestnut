/**
 * File watcher - chokidar wrapper
 *
 * Wraps chokidar to provide our Watcher interface
 */

import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import type { Watcher, WatchEvent, WatchEventType, WatcherErrorContext } from './types.js';

/**
 * Chokidar-based watcher implementation
 */
/**
 * Fallback poller consecutive failure limit. Mirror reader.ts CONSECUTIVE_PARSE_FAIL_LIMIT
 * pattern. After N consecutive callback throws, the fallback poller is disabled and the
 * watcher notifies caller via onError(err, 'fallback_disabled'). Caller decides recovery.
 */
const FALLBACK_CONSECUTIVE_FAIL_LIMIT = 5;

const DEFAULT_FALLBACK_POLL_MS = 500;

class ChokidarWatcher implements Watcher {
  private active = true;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly watcher: FSWatcher,
    private readonly watchPath: string,
    fallbackTimer: ReturnType<typeof setInterval> | null = null,
  ) {
    this.fallbackTimer = fallbackTimer;
  }

  async close(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.active = false;
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    await this.watcher.close();
  }

  isActive(): boolean {
    return this.active;
  }

  getPath(): string {
    return this.watchPath;
  }
}

/**
 * Map chokidar event to our WatchEventType
 */
function mapEventType(chokidarEvent: string): WatchEventType | null {
  switch (chokidarEvent) {
    case 'add':
      return 'add';
    case 'change':
      return 'change';
    case 'unlink':
      return 'unlink';
    case 'addDir':
      return 'addDir';
    case 'unlinkDir':
      return 'unlinkDir';
    default:
      return null;
  }
}

/**
 * Create a file watcher
 * @param absolutePath - Absolute path to watch (file or directory)
 * @param callback - Called on each change event
 * @param options - Watch options
 * @returns Watcher handle
 */
export function createWatcher(
  absolutePath: string,
  callback: (event: WatchEvent) => void,
  options?: {
    /** Watch recursively (for directories) */
    recursive?: boolean;
    /** Ignore patterns */
    ignored?: (string | RegExp)[];
    /** Initial scan callback */
    onReady?: () => void;
    /** Error callback */
    onError?: (err: Error, context: WatcherErrorContext) => void;
    /**
     * Write finish stability strategy.
     * 'stable' (default): 100ms stabilityThreshold — safe for files being written over time.
     * 'immediate': emit on every FS event without stabilization — for append-only log tails.
     */
    stability?: 'stable' | 'immediate';
    /**
     * Whether the watcher holds the event loop alive.
     * Default: true (for daemon loops).
     * Set false for short-lived TUI observers so the process can exit cleanly
     * if a watcher cleanup is missed.
     */
    persistent?: boolean;
    /**
     * Fallback poll interval (ms) / override default 500ms.
     * Only enabled when `stability === 'immediate'` on macOS.
     * Ignored on other platforms or in 'stable' mode.
     */
    fallbackPollMs?: number;
  }
): Watcher {
  const watcher = chokidarWatch(absolutePath, {
    persistent: options?.persistent ?? true,
    ignoreInitial: true,
    depth: options?.recursive ? undefined : 0,
    ignored: options?.ignored,
    awaitWriteFinish: options?.stability === 'immediate'
      ? false
      : { stabilityThreshold: 100, pollInterval: 50 },
  });

  // Map chokidar events to our format
  watcher.on('all', (event, filePath, stats) => {
    const type = mapEventType(event);
    if (!type) {
      return;
    }

    const watchEvent: WatchEvent = {
      type,
      path: filePath,
    };

    if (stats) {
      watchEvent.stats = {
        size: stats.size,
        mtime: stats.mtime,
      };
    }

    try {
      callback(watchEvent);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      try { options?.onError?.(e, 'callback'); } catch { /* swallow secondary */ }
    }
  });

  // Ready event
  watcher.on('ready', () => {
    try {
      options?.onReady?.();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      try { options?.onError?.(e, 'ready'); } catch { /* swallow */ }
    }
  });

  // Error handling
  watcher.on('error', (raw) => {
    const e = raw instanceof Error ? raw : new Error(String(raw));
    try { options?.onError?.(e, 'watch'); } catch { /* swallow */ }
  });

  // Fallback poll for macOS FSEvents silent stall (phase352 / phase469)
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  const enableFallback =
    process.platform === 'darwin' &&
    options?.stability === 'immediate';
  if (enableFallback) {
    const intervalMs = options?.fallbackPollMs ?? DEFAULT_FALLBACK_POLL_MS;
    let consecutiveCallbackFails = 0;
    fallbackTimer = setInterval(() => {
      try {
        callback({ type: 'change', path: absolutePath });
        consecutiveCallbackFails = 0;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        consecutiveCallbackFails++;
        try { options?.onError?.(e, 'callback'); } catch { /* swallow secondary */ }
        if (consecutiveCallbackFails >= FALLBACK_CONSECUTIVE_FAIL_LIMIT) {
          // Disable poller: clearInterval + null + notify via onError 'fallback_disabled'.
          // Caller already covers this via binary discrimination else-branch (FAILED tier).
          if (fallbackTimer) {
            clearInterval(fallbackTimer);
            fallbackTimer = null;
          }
          const disableErr = new Error(
            `fallback poller disabled after ${consecutiveCallbackFails} consecutive callback failures: ${e.message}`,
          );
          try { options?.onError?.(disableErr, 'fallback_disabled'); } catch { /* swallow secondary */ }
        }
      }
    }, intervalMs);
  }

  return new ChokidarWatcher(watcher, absolutePath, fallbackTimer);
}
