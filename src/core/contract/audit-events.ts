/**
 * Contract audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts CONTRACT_ 系列等价 / 0 漂移。
 *
 * RETRO_* 子域 events 已迁出至 ./retro-audit-events.ts（phase383 / r52 H 裁决 1+5）。
 */
export const CONTRACT_AUDIT_EVENTS = {
  LOCK_CLEARED: 'contract_lock_cleared',
  LOCK_UNLINK_FAILED: 'contract_lock_unlink_failed',
  LOCK_SCHEMA_INVALID: 'contract_lock_schema_invalid',   // ← NEW (phase 576)
  PROGRESS_SCHEMA_INVALID: 'contract_progress_schema_invalid',  // ← NEW (phase 587)
  CONTRACT_YAML_SCHEMA_INVALID: 'contract_yaml_schema_invalid', // ← NEW (phase 587)
  PROGRESS_CORRUPTED: 'contract_progress_corrupted',
  ARCHIVE_STARTED: 'contract_archive_started',
  ROLLBACK_FAILED: 'contract_rollback_failed',
  CREATED: 'contract_created',
  ACCEPTANCE_STARTED: 'contract_acceptance_started',
  UPDATED: 'contract_updated',
  NOTIFY_FAILED: 'contract_notify_failed',
  MOVE_ARCHIVE_FAILED: 'contract_move_archive_failed',
  ACCEPTANCE_INBOX_FAILED: 'contract_acceptance_inbox_failed',
  ACCEPTANCE_RESET_FAILED: 'contract_acceptance_reset_failed',
  ACCEPTANCE_BACKGROUND_FAILED: 'contract_acceptance_background_failed',
  ACCEPTANCE_SCRIPT_STARTED: 'contract_acceptance_script_started',
  SUBTASK_DUPLICATE_DONE: 'contract_subtask_duplicate_done',
  SUBTASK_ALREADY_COMPLETED: 'contract_subtask_already_completed',
  UNEXPECTED_ASYNC_THROW: 'contract_unexpected_async_throw',
  // phase345: caller 风格统一并轨（B.p344-1 / contract lifecycle events）
  PASSED: 'acceptance_passed',
  CANCELLED: 'contract_cancelled',
  COMPLETED: 'contract_completed',
  PAUSED: 'contract_paused',
  RESUMED: 'contract_resumed',
  // phase 569 const 化（acceptance.ts 7 处字面量收）
  SUBTASK_COMPLETED: 'subtask_completed',
  ACCEPTANCE_FAILED: 'acceptance_failed',
  ESCALATED: 'contract_escalation',
  ACCEPTANCE_TIMEOUT: 'acceptance_timeout',
  // phase350: A.8 observer 错误暴露
  OBSERVER_EVENT_FAILED: 'contract_observer_event_failed',
  CONTRACT_COMPLETED_HANDLER_FAILED: 'contract_completed_handler_failed',
} as const;
