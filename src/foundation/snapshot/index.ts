/**
 * @module L2.Snapshot
 * 代码快照生成与管理。
 */

export { Snapshot } from './snapshot.js';
// phase 693 Step C: SNAPSHOT_IGNORE_PATTERNS 迁出本模块、归 Assembly 装配组装
// (architecture §29 + phase 157 revert)。各 caller 走 'src/assembly/index.js' barrel。

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
