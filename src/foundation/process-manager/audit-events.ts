/**
 * ProcessManager audit event names.
 *
 * Module-owned event namespace per H1 design (phase334 / r36 α 决策)。
 * 字符串值与 phase148 起 events.ts 中央注册表的 PROCESS_* / PID_* / LOCK_* / LOCKFILE_* / ORPHAN_* 系列等价 / 0 漂移。
 *
 * 注意：PM 模块含 PROCESS / PID / LOCK / LOCKFILE / ORPHAN 5 子资源 / prefix 全保留。
 */
export const PROCESS_MANAGER_AUDIT_EVENTS = {
  PROCESS_SPAWNED: 'process_spawned',
  PROCESS_SPAWN_FAILED: 'process_spawn_failed',
  PROCESS_STOPPED: 'process_stopped',
  PROCESS_STOP_FAILED: 'process_stop_failed',
  PROCESS_KILL_ESCALATED: 'process_kill_escalated',
  PROCESS_STOP_STALE: 'process_stop_stale',
  PID_READ_FAILED: 'pid_read_failed',
  PID_WRITE_OK: 'pid_write_ok',
  PID_WRITE_FAILED: 'pid_write_failed',
  PID_REMOVE_OK: 'pid_remove_ok',
  PID_REMOVE_FAILED: 'pid_remove_failed',
  PID_EMPTY: 'pid_empty',
  PID_FILE_LEGACY_FORMAT: 'pid_file_legacy_format', // ← NEW phase 1023
  PID_FILE_PARSE_FAILED: 'pid_file_parse_failed', // ← NEW phase 1023
  STARTTIME_VERIFY_SKIPPED_WINDOWS: 'starttime_verify_skipped_windows', // ← NEW phase 1023
  STARTTIME_MISMATCH: 'starttime_mismatch', // ← NEW phase 1023 (PID-wrap detection)
  ORPHAN_SIGTERM_FAILED: 'orphan_sigterm_failed',
  ORPHAN_CLEANUP_PARTIAL: 'orphan_cleanup_partial', // ← NEW phase 1060
  ORPHAN_MATCH_SKIPPED: 'orphan_match_skipped', // ← phase 346 B2: clawId token-match miss、防误杀 sibling claw
  STOP_PID_REMOVED_BEFORE_DEAD: 'stop_pid_removed_before_dead', // ← phase 355 C1: SIGKILL 后超 grace 仍 isAlive、ops 诊断
  PID_SPAWNING_RACE_AVOIDED: 'pid_spawning_race_avoided', // ← NEW phase 1009: spawning CAS 删除时内容已变，避免误删真实 PID
  PID_SPAWNING_LOCK_RETRY: 'pid_spawning_lock_retry', // ← NEW phase 1014: stop 在 spawning 分支重试 acquire 互斥锁、超时不删 PID
  LOCKFILE_READ_FAILED: 'lockfile_read_failed',
  LOCKFILE_CLEANUP_FAILED: 'lockfile_cleanup_failed',
  LOCK_ACQUIRED: 'lock_acquired',
  LOCK_RELEASED: 'lock_released',
  PROCESS_LIST_FAILED: 'process_list_failed',
  READY_MARK_WROTE: 'process_ready_mark_wrote',
  READY_MARK_REMOVED: 'process_ready_mark_removed',
  READY_MARK_STALE: 'process_ready_mark_stale',
  READY_STALE_CLEANUP_FAILED: 'process_manager_ready_stale_cleanup_failed',
  READY_CHECK_READ_FAILED: 'process_ready_check_read_failed',
  READY_CHECK_PARSE_FAILED: 'process_ready_check_parse_failed',
  READY_CHECK_ISALIVE_THROW: 'process_ready_check_isalive_throw',
  CLEAN_STOP_SIGNALED: 'clean_stop_signaled',
} as const;
