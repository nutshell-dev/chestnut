/**
 * Contract audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts CONTRACT_ 系列等价 / 0 漂移。
 */
export const CONTRACT_AUDIT_EVENTS = {
  LOCK_CLEARED: 'contract_lock_cleared',
  LOCK_UNLINK_FAILED: 'contract_lock_unlink_failed',
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
  ACCEPTANCE_SCRIPT_STARTED: 'contract_acceptance_script_started',
  SUBTASK_DUPLICATE_DONE: 'contract_subtask_duplicate_done',
  SUBTASK_ALREADY_COMPLETED: 'contract_subtask_already_completed',
  RETRO_INDEX_FAILED: 'contract_retro_index_failed',
  RETRO_YAML_FAILED: 'contract_retro_yaml_failed',
  RETRO_SKILL_FAILED: 'contract_retro_skill_failed',
  RETRO_MINING_FAILED: 'contract_retro_mining_failed',
  RETRO_SCHEDULE_FAILED: 'contract_retro_schedule_failed',
  RETRO_CLEANUP_FAILED: 'contract_retro_cleanup_failed',
} as const;
