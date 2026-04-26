/**
 * SubAgent audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts SUBAGENT_ 系列等价 / 0 漂移。
 */
export const SUBAGENT_AUDIT_EVENTS = {
  STEP_COMPLETE_FAILED: 'subagent_step_complete_failed',
  PERSIST_FAILED: 'subagent_persist_failed',
  LOG_APPEND_FAILED: 'subagent_log_append_failed',
} as const;
