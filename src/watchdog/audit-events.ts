// src/watchdog/audit-events.ts
/**
 * Watchdog audit event names.
 *
 * Module-owned event namespace per H1 design (phase336 / r36 α 决策 / H1 收官).
 * 字符串值与起步态 events.ts WATCHDOG_* + CLAW_CRASH_* 系列等价 / 0 漂移。
 */
export const WATCHDOG_AUDIT_EVENTS = {
  CLEANUP_FAILED: 'watchdog_cleanup_failed',
  CRASH: 'watchdog_crash',
  CLAW_SCAN: 'watchdog_claw_scan',
  CLAW_CRASH_DETECTED: 'claw_crash_detected',
  CLAW_CRASH_NOTIFY_DEDUPED: 'watchdog_claw_crash_notify_deduped',
  CLAW_CRASH_SKIPPED_NO_CONTRACT: 'watchdog_claw_crash_skipped_no_contract',
  CLAW_CRASH_NOTIFY_RESET: 'watchdog_claw_crash_notify_reset',
  STATE_LOAD_FAILED: 'watchdog_state_load_failed',
  STATE_SCHEMA_INVALID: 'watchdog_state_schema_invalid',
  PID_CORRUPT: 'watchdog_pid_corrupt',
  PID_FOREIGN_WORKSPACE: 'watchdog_pid_foreign_workspace',
  PID_READ_FAILED: 'watchdog_pid_read_failed',
  PID_STALE_AUTO_CLEANED: 'watchdog_pid_stale_auto_cleaned',
  ENSURE_LOCK_TIMEOUT: 'watchdog_ensure_lock_timeout',
  ENSURE_LOCK_STALE_RECOVERED: 'watchdog_ensure_lock_stale_recovered',
  ORPHAN_SWEEP_KILLED: 'watchdog_orphan_sweep_killed',
  ORPHAN_SWEEP_FAILED: 'watchdog_orphan_sweep_failed',
  STOP: 'watchdog_stop',
  CLAW_HAS_CONTRACT_CHECK_FAILED: 'claw_has_contract_check_failed',
  STREAM_READ_FAILED: 'watchdog_stream_read_failed',
  SUBSCRIPTION_FIRED: 'watchdog_subscription_fired',
  SUBSCRIPTION_CONSUMED_RECOVERED: 'watchdog_subscription_consumed_recovered',
  SUBSCRIPTION_CONSUMED_NO_CONTRACT: 'watchdog_subscription_consumed_no_contract',
  SUBSCRIPTION_CORRUPT: 'watchdog_subscription_corrupt',
  CONTRACT_DIR_SCAN_FAILED: 'watchdog_contract_dir_scan_failed',
  CLAW_DIR_LIST_FAILED: 'watchdog_claw_dir_list_failed',
  CLAWS_DIR_LIST_FAILED: 'watchdog_claws_dir_list_failed',
  SUBSCRIPTION_DIR_LIST_FAILED: 'watchdog_subscription_dir_list_failed',
  CLAW_INACTIVITY_CHECK_FAILED: 'watchdog_claw_inactivity_check_failed',
  SUBSCRIPTION_PROCESS_FAILED: 'watchdog_subscription_process_failed',
  WATCHDOG_RESTART_TRIGGERED: 'watchdog_restart_triggered',
  WATCHDOG_START: 'watchdog_start',
  WATCHDOG_CHECK: 'watchdog_check',
  // phase 324 H3: motion 连续 restart 失败触顶 → circuit-open、停 spawn
  WATCHDOG_GAVE_UP: 'watchdog_gave_up',
  // phase 346 B3 (review-2026-06-13): PID-reuse 探测 / argv 不匹配 skip kill
  ORPHAN_SWEEP_PID_REUSE_SKIPPED: 'watchdog_orphan_sweep_pid_reuse_skipped',
  PID_REUSE_DETECTED: 'watchdog_pid_reuse_detected',
  // phase 472 (review N3-L): stopCommand SIGTERM/SIGKILL syscall 失败可观察化
  STOP_SIGTERM_FAILED: 'watchdog_stop_sigterm_failed',
  STOP_SIGKILL_FAILED: 'watchdog_stop_sigkill_failed',
} as const;


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 */
export const WATCHDOG_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  watchdog_cleanup_failed: 'audit',
  watchdog_crash: 'audit',
  watchdog_claw_scan: 'audit',
  claw_crash_detected: 'audit',
  watchdog_claw_crash_notify_deduped: 'audit',
  watchdog_claw_crash_skipped_no_contract: 'audit',
  watchdog_claw_crash_notify_reset: 'audit',
  watchdog_state_load_failed: 'audit',
  watchdog_state_schema_invalid: 'audit',
  watchdog_pid_corrupt: 'audit',
  watchdog_pid_foreign_workspace: 'audit',
  watchdog_pid_read_failed: 'audit',
  watchdog_pid_stale_auto_cleaned: 'audit',
  watchdog_ensure_lock_timeout: 'audit',
  watchdog_ensure_lock_stale_recovered: 'audit',
  watchdog_orphan_sweep_killed: 'audit',
  watchdog_orphan_sweep_failed: 'audit',
  watchdog_stop: 'audit',
  watchdog_stop_sigterm_failed: 'audit',
  watchdog_stop_sigkill_failed: 'audit',
  claw_has_contract_check_failed: 'audit',
  watchdog_stream_read_failed: 'audit',
  watchdog_subscription_fired: 'audit',
  watchdog_subscription_consumed_recovered: 'audit',
  watchdog_subscription_consumed_no_contract: 'audit',
  watchdog_subscription_corrupt: 'audit',
  watchdog_contract_dir_scan_failed: 'audit',
  watchdog_claw_dir_list_failed: 'audit',
  watchdog_claws_dir_list_failed: 'audit',
  watchdog_subscription_dir_list_failed: 'audit',
  watchdog_claw_inactivity_check_failed: 'audit',
  watchdog_subscription_process_failed: 'audit',
  watchdog_restart_triggered: 'audit',
  watchdog_start: 'audit',
  watchdog_orphan_sweep_pid_reuse_skipped: 'audit',
  watchdog_pid_reuse_detected: 'audit',
  watchdog_check: 'audit',
  watchdog_gave_up: 'audit',
} as const;
