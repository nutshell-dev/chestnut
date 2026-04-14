/**
 * FileWatcher module (L2)
 *
 * 文件系统变化通知。polling 补漏、多平台差异抹平。
 */

export type { WatchEventType, WatchEvent, Watcher } from './types.js';
export { createWatcher } from './watcher.js';
