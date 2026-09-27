/**
 * Snapshot audit event names.
 *
 * Module-owned event namespace per H1 design (phase334 / r36 α 决策).
 * 字符串值与 phase148 起 events.ts 中央注册表的 SNAPSHOT_* 系列等价 / 0 漂移。
 */
export const SNAPSHOT_AUDIT_EVENTS = {
  INIT_FAILED: 'snapshot_init_failed',
  INIT_CLEANUP_FAILED: 'snapshot_init_cleanup_failed',
  COMMIT_FAILED: 'snapshot_commit_failed',
  COMMITTED: 'snapshot_committed',
  DEGRADED: 'snapshot_degraded',
  SYNC_CLEAN_FAILED: 'snapshot_sync_clean_failed',
  SYNC_RESTORE_FAILED: 'snapshot_sync_restore_failed',
  STATUS_STDERR: 'snapshot_status_stderr',
  PERSIST_FAILED: 'snapshot_persist_failed',
  TRY_CLEAR_FAILED: 'snapshot_try_clear_failed',
  STATE_CORRUPT: 'snapshot_state_corrupt',
  REALPATH_FAILED: 'snapshot_realpath_failed',
  STATE_INVARIANT_VIOLATED: 'snapshot_state_invariant_violated',
  STATE_CROSS_SOURCE_MISMATCH: 'snapshot_state_cross_source_mismatch',
  STATE_CROSS_SOURCE_SKIPPED: 'snapshot_state_cross_source_skipped',
  LEGACY_SCHEMA_MIGRATED: 'snapshot_legacy_schema_migrated',
  // phase 1918 Step B: 通用版本库（version-store）事件族
  VERSION_INIT_FAILED: 'snapshot_version_init_failed',
  VERSION_WORKSPACE_BEGAN: 'snapshot_version_workspace_began',
  VERSION_SAVED: 'snapshot_version_saved',
  VERSION_SAVE_FAILED: 'snapshot_version_save_failed',
  // phase 1918 Step C: 按路径条件发布
  VERSION_PUBLISHED: 'snapshot_version_published',
  VERSION_PUBLISH_CONFLICT: 'snapshot_version_publish_conflict',
  VERSION_PUBLISH_BUSY: 'snapshot_version_publish_busy',
  VERSION_PUBLISH_FAILED: 'snapshot_version_publish_failed',
} as const;


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 */
export const SNAPSHOT_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  snapshot_init_failed: 'audit',
  snapshot_init_cleanup_failed: 'audit',
  snapshot_commit_failed: 'audit',
  snapshot_committed: 'audit',
  snapshot_degraded: 'audit',
  snapshot_sync_clean_failed: 'audit',
  snapshot_sync_restore_failed: 'audit',
  snapshot_status_stderr: 'audit',
  snapshot_persist_failed: 'audit',
  snapshot_try_clear_failed: 'audit',
  snapshot_state_corrupt: 'audit',
  snapshot_realpath_failed: 'audit',
  snapshot_state_invariant_violated: 'audit',
  snapshot_state_cross_source_mismatch: 'audit',
  snapshot_state_cross_source_skipped: 'audit',
  snapshot_legacy_schema_migrated: 'audit',
  snapshot_version_init_failed: 'audit',
  snapshot_version_workspace_began: 'audit',
  snapshot_version_saved: 'audit',
  snapshot_version_save_failed: 'audit',
  snapshot_version_published: 'audit',
  snapshot_version_publish_conflict: 'audit',
  snapshot_version_publish_busy: 'audit',
  snapshot_version_publish_failed: 'audit',
} as const;
