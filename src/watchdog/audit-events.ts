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
  CLAW_CRASH_NOTIFY_DROPPED: 'claw_crash_notify_dropped',
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
} as const;
