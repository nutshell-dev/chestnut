/**
 * File watcher - chokidar wrapper
 *
 * Wraps chokidar to provide our Watcher interface
 */

import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import type { Watcher, WatchEvent, WatchEventType, WatcherErrorContext } from './types.js';

/**
 * Fallback poller consecutive failure limit. Mirror reader.ts CONSECUTIVE_PARSE_FAIL_LIMIT
 * pattern. After N consecutive callback throws, the fallback poller is disabled and the
 * watcher notifies caller via onError(err, 'fallback_limit_reset'). Caller decides recovery.
 *
 * Value: 5 = empirical（mirror stream/reader.ts:25 CONSECUTIVE_PARSE_FAIL_LIMIT 同模板 / 平衡
 * transient FS error 容忍 vs 系统真坏立 fail-loud / 调小过敏 / 调大延迟 fail-loud）
 */
const FALLBACK_CONSECUTIVE_FAIL_LIMIT = 5;

/**
 * Fallback poll interval (ms) / chokidar native-watcher silent stall 兜底.
 *
 * Cross-platform fallback poll for chokidar 'immediate' mode callers:
 * - macOS: FSEvents coalescing 50-200ms 物理下界 (phase 352 / phase 469)
 * - Linux CI: tmpfs/overlayfs inotify silent stall (phase 760)
 * - Windows: ReadDirectoryChangesW edge cases
 *
 * Value: 500ms 物理下界 / 用户可经 createWatcher options.fallbackPollMs 自定义
 */
const DEFAULT_FALLBACK_POLL_MS = 500;

/**
 * Chokidar awaitWriteFinish stability threshold (ms).
 * 等待 file write 停止 N ms 视为「写完成」/ 防 partial-write 触发 read 提前.
 * Value: 100ms = chokidar README 推荐起步值 / 平衡 file-write-burst 检测 vs delivery latency.
 */
// phase 1212: file-private restored (dispatch-latency test phase 1147 重写改 source-grep 不需 import)
const CHOKIDAR_STABILITY_THRESHOLD_MS = 100;

/**
 * Chokidar awaitWriteFinish poll interval (ms).
 * file size 监测频率 / 检 stability 收敛.
 * Value: 50ms = chokidar 默认 / < stability threshold / 保 poll 至少 2 次内 detect stability.
 */
// phase 1212: file-private restored (same reason as STABILITY_THRESHOLD_MS)
const CHOKIDAR_POLL_INTERVAL_MS = 50;

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
 * Create a file watcher wrapping chokidar.
 *
 * **⚠ CI inotify caveat (phase 743)**:
 * - chokidar single-file watch on a non-existent path: 'ready' fires normally,
 *   but subsequent 'add' when the file appears is unreliable on CI
 * - GitHub Actions Linux runner overlayfs / tmpfs inotify fails to detect
 *   single-file path creation events
 * - Callers should ensure the file exists before calling createWatcher
 *   (mirror StreamWriter.open() pattern)
 * - Watching an existing file for subsequent 'change' events is reliable
 * - For unit-testing createWatcher wrapper logic, mock chokidar
 *   (see tests/foundation/file-watcher.test.ts phase 743 step C)
 *
 * See design/practices.md §B.chokidar-ci-inotify-limit
 *
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
     * Only enabled when `stability === 'immediate'`.
     * Ignored in 'stable' mode.
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
      : {
          stabilityThreshold: CHOKIDAR_STABILITY_THRESHOLD_MS,
          pollInterval: CHOKIDAR_POLL_INTERVAL_MS,
        },
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
      try { options?.onError?.(e, 'callback'); } catch { /* silent: secondary callback error swallowed / onError 已报 primary / 不重复抛 */ }
    }
  });

  // Ready event
  watcher.on('ready', () => {
    try {
      options?.onReady?.();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      try { options?.onError?.(e, 'ready'); } catch { /* silent: caller onError callback own audit responsibility / fail-soft 防 callback bug 破 watcher init */ }
    }
  });

  // Error handling
  watcher.on('error', (raw) => {
    const e = raw instanceof Error ? raw : new Error(String(raw));
    try { options?.onError?.(e, 'watch'); } catch { /* silent: caller onError callback own audit responsibility / fail-soft 防 callback bug 破 watcher init */ }
  });

  // Fallback poll for chokidar native-watcher silent stall (cross-platform, phase 352 / 469 / 760)
  // macOS FSEvents + Linux CI inotify + Windows ReadDirectoryChangesW silent stall 同型治理
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  const enableFallback = options?.stability === 'immediate';
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
        try { options?.onError?.(e, 'callback'); } catch { /* silent: secondary callback error swallowed / onError 已报 primary / 不重复抛 */ }
        if (consecutiveCallbackFails >= FALLBACK_CONSECUTIVE_FAIL_LIMIT) {
          // phase 1082: reset counter instead of permanent disable to avoid silent stall
          consecutiveCallbackFails = 0;
          const disableErr = new Error(
            `fallback poller callback failure limit reached: ${e.message}`,
          );
          try { options?.onError?.(disableErr, 'fallback_limit_reset'); } catch { /* silent: secondary callback error swallowed / onError 已报 primary / 不重复抛 */ }
        }
      }
    }, intervalMs);
    fallbackTimer.unref?.();
  }

  return new ChokidarWatcher(watcher, absolutePath, fallbackTimer);
}
