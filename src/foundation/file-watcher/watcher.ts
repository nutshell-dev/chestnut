/**
 * File watcher - chokidar wrapper
 *
 * Wraps chokidar to provide our Watcher interface
 */

import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import type { Watcher, WatchEvent, WatchEventType } from './types.js';
import type { IFileSystem } from '../fs/types.js';

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
 * @param options - Watch options
 * @returns Watcher handle
 */
export function createWatcher(
  fs: IFileSystem,
  relativePath: string,
  callback: (event: WatchEvent) => void,
  options?: {
    /** Watch recursively (for directories) */
    recursive?: boolean;
    /** Ignore patterns */
    ignored?: (string | RegExp)[];
    /** Initial scan callback */
    onReady?: () => void;
    /** Error callback */
    onError?: (error: Error) => void;
  }
): Watcher {
  const watchPath = fs.resolve(relativePath);
  const watcher = chokidarWatch(watchPath, {
    persistent: true,
    ignoreInitial: true,
    depth: options?.recursive ? undefined : 0,
    ignored: options?.ignored,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
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

    callback(watchEvent);
  });

  // Ready event
  watcher.on('ready', () => {
    options?.onReady?.();
  });

  // Error handling
  watcher.on('error', (error) => {
    console.error('Watcher error:', error);
    options?.onError?.(error instanceof Error ? error : new Error(String(error)));
  });

  return new ChokidarWatcher(watcher, watchPath);
}
