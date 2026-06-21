/**
 * @module L2.Snapshot
 * 代码快照生成与管理。
 */

export { Snapshot } from './snapshot.js';
export { SNAPSHOT_IGNORE_PATTERNS } from './patterns.js';

import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import { Snapshot } from './snapshot.js';

export function createSnapshot(
  dir: string,
  fs: FileSystem,
  audit: AuditLog,
  ignorePatterns: readonly string[],
  syncCleanupDirs?: readonly string[],
): Snapshot {
  return new Snapshot(dir, fs, audit, ignorePatterns, syncCleanupDirs);
}
