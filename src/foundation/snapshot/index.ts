/**
 * @module L2a.Snapshot
 * 代码快照生成与管理。
 */

export { Snapshot } from './snapshot.js';
export type { SnapshotCommitter, SnapshotCommitResult } from './snapshot.js';
// phase 693 Step C: SNAPSHOT_IGNORE_PATTERNS 迁出本模块、归 Assembly 装配组装
// (architecture §29 + phase 157 revert)。各 caller 走 'src/assembly/index.js' barrel。

export { createSnapshot } from './snapshot.js';
export { SNAPSHOT_FILE_ROUTING } from './audit-events.js';
