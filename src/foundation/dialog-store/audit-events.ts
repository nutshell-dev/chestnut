/**
 * DialogStore audit event names.
 *
 * Module-owned event namespace per H1 design (phase334 / r36 α 决策)。
 * 字符串值与 phase148 起 events.ts 中央注册表的 SESSION_* 系列等价 / 0 漂移。
 */
export const DIALOG_AUDIT_EVENTS = {
  LOAD_FAILED: 'session_load_failed',
  SAVE_FAILED: 'session_save_failed',
  CORRUPTED: 'session_corrupted',
  CORRUPTED_ISOLATE_FAILED: 'session_corrupted_isolate_failed',
  RECOVERED: 'session_recovered',
  ARCHIVE_FAILED: 'session_archive_failed',
  ARCHIVE_READ_FAILED: 'session_archive_read_failed',
  ARCHIVE_PARSE_FAILED: 'session_archive_parse_failed',
  ARCHIVE_DIR_FAILED: 'session_archive_dir_failed',
  VERSION_UNKNOWN: 'dialog_session_version_unknown',  // ← NEW phase 1019 r124 E fork
  VERSION_MIGRATE: 'dialog_session_version_migrate',  // ← NEW phase 1019 r124 E fork (v1→v2 observability)
  INVARIANT_FAILED: 'dialog_invariant_failed', // ← NEW phase 1024 G.4
  COLD_START: 'dialog_cold_start',              // ← NEW phase 1054
  ARCHIVE_EMPTY: 'dialog_archive_empty',         // ← NEW phase 1054
  ARCHIVE_ALL_CORRUPTED: 'dialog_archive_all_corrupted', // ← NEW phase 1054
  TURN_BOUNDARY_TRUNCATED: 'dialog_turn_boundary_truncated', // ← NEW phase 1184 (mid-turn 逻辑边界 race protection layer 2)
  TURN_BEGIN: 'dialog_turn_begin',
  TURN_COMMIT: 'dialog_turn_commit',
  TURN_ROLLBACK: 'dialog_turn_rollback',
  FLUSH_CHAIN_ERROR: 'dialog_flush_chain_error',
  CLEANUP_ARCHIVES_DELETE_FAILED: 'dialog_cleanup_archives_delete_failed',
} as const;
