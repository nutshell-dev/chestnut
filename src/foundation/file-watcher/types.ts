/**
 * FileWatcher types (L1)
 *
 * 文件系统变化通知的类型定义。
 * 不懂业务目录语义，不读文件内容。
 */

export type WatchEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface WatchEvent {
  type: WatchEventType;
  path: string;
  stats?: {
    size: number;
    mtime: Date;
  };
}

export interface Watcher {
  /** Stop watching and clean up resources */
  close(): Promise<void>;

  /** Check if watcher is still active */
  isActive(): boolean;

  /** Get the watched path */
  getPath(): string;
}

export type WatcherErrorContext = 'watch' | 'callback' | 'ready' | 'fallback_disabled';
