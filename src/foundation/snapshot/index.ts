/**
 * @module L2a.Snapshot
 * 代码快照生成与管理。
 */

export { Snapshot } from './snapshot.js';
export type {
  SnapshotCommitter,
  SnapshotCommitResult,
  SnapshotIgnoreMigration,
  SnapshotIgnoreRefreshResult,
} from './snapshot.js';
// phase 693 Step C: SNAPSHOT_IGNORE_PATTERNS 迁出本模块、归 Assembly 装配组装
// (architecture §29 + phase 157 revert)。各 caller 走 'src/assembly/index.js' barrel。

export { createSnapshot } from './snapshot.js';
export { SNAPSHOT_FILE_ROUTING } from './audit-events.js';
export { snapshotMaintenanceConfigSchema } from './config-schema.js';
export type { SnapshotMaintenanceConfig } from './config-schema.js';
export {
  SNAPSHOT_MAINTENANCE_DEFAULT_TIMEOUT_MS,
  SNAPSHOT_MAINTENANCE_DEFAULT_GIT_WARN_BYTES,
  SNAPSHOT_MAINTENANCE_DEFAULT_LOOSE_OBJECT_WARN_COUNT,
  SNAPSHOT_MAINTENANCE_DEFAULT_DISK_AVAILABLE_WARN_BYTES,
} from './maintenance.js';
export type {
  SnapshotMaintenanceOptions,
  SnapshotMaintenanceResult,
  SnapshotMaintenanceThresholds,
  SnapshotRepositoryStats,
  SnapshotSpaceWarning,
} from './maintenance-types.js';

// phase 1918 Step B: 通用目录版本库（分支工作区 begin/save；publish 与固定版本读取
// 在 Step C/D 顺序扩展）。窄出口：factory + 类型契约，内部 Git 协议不外泄。
export { createVersionStore } from './version-store.js';
export type { VersionStoreOptions } from './version-store.js';
export { VersionStoreError } from './version-types.js';
export type {
  EditWorkspace,
  OperationId,
  OperationInspection,
  PublishInput,
  PublishResult,
  VersionHistoryEntry,
  VersionId,
  VersionStore,
  VersionStoreErrorKind,
} from './version-types.js';
