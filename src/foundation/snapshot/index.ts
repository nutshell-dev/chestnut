/**
 * @module L2.Snapshot
 * 代码快照生成与管理。
 */

export { Snapshot } from './snapshot.js';
export * from './audit-emit.js';

import type { FileSystem } from '../fs/types.js';
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
