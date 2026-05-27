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
} as const;
