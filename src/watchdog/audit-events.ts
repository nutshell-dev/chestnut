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
  STOP: 'watchdog_stop',
  CLAW_HAS_CONTRACT_CHECK_FAILED: 'claw_has_contract_check_failed',
  STREAM_READ_FAILED: 'watchdog_stream_read_failed',
} as const;
