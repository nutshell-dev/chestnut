/**
 * @module L1.FileWatcher
 * FileWatcher module (L1)
 *
 * 文件系统变化通知。polling 补漏、多平台差异抹平。
 */

export type { WatchEventType, WatchEvent, Watcher, WatcherErrorContext, WatcherFactory } from './types.js';
export {
  createWatcher,
  FALLBACK_CONSECUTIVE_FAIL_LIMIT,
  CHOKIDAR_STABILITY_THRESHOLD_MS,
  CHOKIDAR_POLL_INTERVAL_MS,
} from './watcher.js';
