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
  LOCK_CLEANUP_FAILED: 'contract_lock_cleanup_failed',   // ← NEW (phase 850 / r108 F fork F2.1)
  LOCK_RETRY: 'contract_lock_retry',                    // ← NEW (phase 1325 / r137 B fork)
  PROGRESS_SCHEMA_INVALID: 'contract_progress_schema_invalid',  // ← NEW (phase 587)
  CONTRACT_YAML_LEGACY_ACCEPTANCE_FIELD: 'contract_yaml_legacy_acceptance_field', // ← NEW phase 1257 r134 C fork (mirror PID_FILE_LEGACY_FORMAT phase 1023+1180 模板)
  CONTRACT_YAML_LEGACY_ESCALATION_FIELD: 'contract_yaml_legacy_escalation_field', // ← NEW phase 1399: escalation.max_retries → verification_attempts 30天兼容
  CONTRACT_YAML_SCHEMA_INVALID: 'contract_yaml_schema_invalid', // ← NEW (phase 587)
  OBSERVER_STATE_PARSE_FAILED: 'contract_observer_state_parse_failed',  // ← NEW (phase 1012 / r123 C fork)
  PROGRESS_CORRUPTED: 'contract_progress_corrupted',
  ARCHIVE_STARTED: 'contract_archive_started',
  ROLLBACK_FAILED: 'contract_rollback_failed',
  ROLLBACK_INCOMPLETE: 'contract_rollback_incomplete',
  CREATED: 'contract_created',
  VERIFICATION_STARTED: 'contract_verification_started',
  UPDATED: 'contract_updated',
  NOTIFY_FAILED: 'contract_notify_failed',
  MOVE_ARCHIVE_FAILED: 'contract_move_archive_failed',
  VERIFICATION_INBOX_FAILED: 'contract_verification_inbox_failed',
  VERIFICATION_RESET_FAILED: 'contract_verification_reset_failed',
  VERIFICATION_BACKGROUND_FAILED: 'contract_verification_background_failed',
  COMPLETE_ON_CANCELLED: 'contract_complete_on_cancelled',
  VERIFICATION_BACKGROUND_DONE: 'contract_verification_background_done',
  VERIFICATION_SCRIPT_STARTED: 'contract_verification_script_started',
  SUBTASK_DUPLICATE_DONE: 'contract_subtask_duplicate_done',
  SUBTASK_ALREADY_COMPLETED: 'contract_subtask_already_completed',
  UNEXPECTED_ASYNC_THROW: 'contract_unexpected_async_throw',
  // phase345: caller 风格统一并轨（B.p344-1 / contract lifecycle events）
  PASSED: 'verification_passed',
  CANCELLED: 'contract_cancelled',
  COMPLETED: 'contract_completed',
  PAUSED: 'contract_paused',
  RESUMED: 'contract_resumed',
  // phase 569 const 化（verification.ts 7 处字面量收）
  SUBTASK_COMPLETED: 'subtask_completed',
  SUBTASK_FORCE_ACCEPTED: 'subtask_force_accepted', // ← NEW phase 1399: force-accept 路径审计
  VERIFICATION_FAILED: 'verification_failed',
  VERIFICATION_TIMEOUT: 'verification_timeout',
  // phase 993 D.2 (r121 J fork audit-2026-05-17 NEW.P1 D.2): verifier catch audit emit (timeout/other)
  VERIFIER_FAILED: 'contract_verifier_failed',
  // phase 1080: verifier skipped because contract was cancelled
  VERIFIER_SKIPPED: 'contract_verifier_skipped',
  // NEW phase1108: verifier lifecycle observability
  VERIFIER_STARTED: 'contract_verifier_started',
  VERIFIER_PASSED: 'contract_verifier_passed',
  // NEW phase1133 (r126 C fork C-3): done tool result first JSON.parse silent fall-through audit
  VERIFIER_RESULT_PARSE_FAILED: 'contract_verifier_result_parse_failed',
  // phase350: A.8 observer 错误暴露
  OBSERVER_EVENT_FAILED: 'contract_observer_event_failed',
  CONTRACT_SYSTEM_CLOSED: 'contract_system_closed',
  CONTRACT_COMPLETED_HANDLER_FAILED: 'contract_completed_handler_failed',
  // phase 1010 r123 B fork: silent X catch ALL TODO cluster narrow (audit-2026-05-18 §Section 1)
  EVENT_COLLECTOR_SCAN_FAILED: 'contract_event_collector_scan_failed',
  CONTRACT_DIR_SCAN_FAILED: 'contract_dir_scan_failed',
  OBSERVER_STATE_LOAD_FAILED: 'contract_observer_state_load_failed',
  // phase 1335 (r138 F fork): boot reconcile audit emit trace
  CONTRACT_BOOT_RECONCILE: 'contract_boot_reconcile',
  CONTRACT_BOOT_MIGRATE_ESCALATED: 'contract_boot_migrate_escalated', // ← NEW phase 1399: boot 时 escalated 残留 migrate
  // phase 1362 (r140): contractDir → acquireLock TOCTOU race retry audit trace
  CONTRACT_DIR_RACE_RETRY: 'contract_dir_race_retry',
  // phase 1371 sub-2: archiveAndEmit partial recovery audit trace
  ARCHIVE_PARTIAL_RECOVERY_FAILED: 'contract_archive_partial_recovery_failed',
  ARCHIVE_RECOVERED: 'contract_archive_recovered',
  // phase 1371 sub-3: verification pipeline mutex race rejection audit trace
  VERIFICATION_PIPELINE_RACE_REJECTED: 'verification_pipeline_race_rejected',
  // phase 1235 B.3: typed emit empty contractId invariant
  TYPED_EMIT_INVARIANT_VIOLATION: 'contract_typed_emit_invariant_violation',
} as const;
