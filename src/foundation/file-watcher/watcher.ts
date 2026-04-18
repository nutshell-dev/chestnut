/**
 * File watcher - chokidar wrapper
 *
 * Wraps chokidar to provide our Watcher interface
 */

import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import type { Watcher, WatchEvent, WatchEventType } from './types.js';
import type { FileSystem } from '../fs/types.js';
import type { Audit } from '../audit/index.js';
import { AUDIT_EVENTS } from '../audit/events.js';

/**
 * Chokidar-based watcher implementation
 */
class ChokidarWatcher implements Watcher {
  private active = true;

  constructor(
    private readonly watcher: FSWatcher,
    private readonly watchPath: string
  ) {}

  async close(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.active = false;
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
 * @param fs - FileSystem instance for path resolution
 * @param relativePath - Relative path to watch (file or directory)
 * @param callback - Called on each change event
 * @param audit - Audit sink (必传)
 * @param options - Watch options
 * @returns Watcher handle
 */
export function createWatcher(
  fs: FileSystem,
  relativePath: string,
  callback: (event: WatchEvent) => void,
  audit: Audit,
  options?: {
    /** Watch recursively (for directories) */
    recursive?: boolean;
    /** Ignore patterns */
    ignored?: (string | RegExp)[];
    /** Initial scan callback */
    onReady?: () => void;
    /** Error callback */
    onError?: (error: Error) => void;
    /**
     * Write finish stability strategy.
     * 'stable' (default): 100ms stabilityThreshold — safe for files being written over time.
     * 'immediate': emit on every FS event without stabilization — for append-only log tails.
     */
    stability?: 'stable' | 'immediate';
  }
): Watcher {
  const watchPath = fs.resolve(relativePath);
  const watcher = chokidarWatch(watchPath, {
    persistent: true,
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
      audit.write(
        AUDIT_EVENTS.WATCHER_CALLBACK_FAILED,
        `path=${filePath}`,
        `event=${type}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // Ready event
  watcher.on('ready', () => {
    try {
      options?.onReady?.();
    } catch (err) {
      audit.write(
        AUDIT_EVENTS.WATCHER_READY_FAILED,
        `path=${watchPath}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // Error handling
  watcher.on('error', (rawError) => {
    const normalizedError = rawError instanceof Error ? rawError : new Error(String(rawError));
    audit.write(
      AUDIT_EVENTS.WATCHER_ERROR,
      `path=${watchPath}`,
      `reason=${normalizedError.message}`,
    );
    try {
      options?.onError?.(normalizedError);
    } catch (cbErr) {
      audit.write(
        AUDIT_EVENTS.WATCHER_ERROR,
        `path=${watchPath}`,
        `context=onError_handler`,
        `reason=${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
      );
    }
  });

  return new ChokidarWatcher(watcher, watchPath);
}
