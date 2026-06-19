/**
 * Contract audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts CONTRACT_ 系列等价 / 0 漂移。
 *
 * RETRO_* 子域 events 已迁出至 ./retro-audit-events.ts（phase383 / r52 H 裁决 1+5）。
 */

import type { IdNamingEntry } from '../../foundation/audit/types.js';

export const CONTRACT_AUDIT_EVENTS = {
  LOCK_CLEARED: 'contract_lock_cleared',
  LOCK_UNLINK_FAILED: 'contract_lock_unlink_failed',
  LOCK_SCHEMA_INVALID: 'contract_lock_schema_invalid',   // ← NEW (phase 576)
  LOCK_CLEANUP_FAILED: 'contract_lock_cleanup_failed',   // ← NEW (phase 850 / r108 F fork F2.1)
  LOCK_RETRY: 'contract_lock_retry',                    // ← NEW (phase 1325 / r137 B fork)
  PROGRESS_SCHEMA_INVALID: 'contract_progress_schema_invalid',  // ← NEW (phase 587)
  CONTRACT_YAML_SCHEMA_INVALID: 'contract_yaml_schema_invalid', // ← NEW (phase 587)
  OBSERVER_STATE_PARSE_FAILED: 'contract_observer_state_parse_failed',  // ← NEW (phase 1012 / r123 C fork)
  // NEW phase 160: maybeAuditStep loadActive silent catch audit emit (playbook §1)
  AUDITOR_LOAD_ACTIVE_FAILED: 'contract_auditor_load_active_failed',
  // NEW phase 164: listArchiveContracts progress.json non-ENOENT silent catch audit emit (playbook §1)
  ARCHIVE_PROGRESS_READ_FAILED: 'contract_archive_progress_read_failed',
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
  // phase 422 Step C (review medium audit-emit-implies-no-write): cancelContract
  // 半态留痕 — saveProgress 已写 'cancelled' 但 fs.move 失败、source 含 cancelled
  // progress、target dir 缺/半成。
  CANCEL_PARTIAL_FAILED: 'contract_cancel_partial_failed',
  CRASHED: 'contract_crashed',                  // phase 63 NEW
  COMPLETED: 'contract_completed',
  PAUSED: 'contract_paused',
  RESUMED: 'contract_resumed',
  // phase 569 const 化（verification.ts 7 处字面量收）
  SUBTASK_COMPLETED: 'subtask_completed',
  SUBTASK_FORCE_ACCEPTED: 'subtask_force_accepted', // ← NEW phase 1399: force-accept 路径审计
  // ← NEW phase 425: handleVerificationErrorRetry 内 retry path saveProgress 后 audit、补 verification 缺口
  SUBTASK_RESET_TO_TODO: 'contract_subtask_reset_to_todo',
  // phase 324 H6: 旧 contract 被新 contract 替换时、未完成 subtask 被 force-complete 的审计
  SUBTASK_FORCE_COMPLETED_REPLACED: 'subtask_force_completed_replaced',
  VERIFICATION_FAILED: 'verification_failed',
  VERIFICATION_TIMEOUT: 'verification_timeout',
  // phase 993 D.2 (r121 J fork audit-2026-05-17 NEW.P1 D.2): verifier catch audit emit (timeout/other)
  VERIFIER_FAILED: 'contract_verifier_failed',
  // phase 1080: verifier skipped because contract was cancelled
  VERIFIER_SKIPPED: 'contract_verifier_skipped',
  // NEW phase1108: verifier lifecycle observability
  VERIFIER_STARTED: 'contract_verifier_started',
  VERIFIER_PASSED: 'contract_verifier_passed',
  // NEW phase 376: verifier controller register/unregister observability (event-driven test waits)
  VERIFIER_REGISTERED: 'contract_verifier_registered',
  VERIFIER_UNREGISTERED: 'contract_verifier_unregistered',
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
  // phase 37: observer race 治本 / v1→v2 schema migration 后首 tick bootstrap 完成 trace
  OBSERVER_BOOTSTRAP_DONE: 'contract_observer_bootstrap_done',
  // phase 1335 (r138 F fork): boot reconcile audit emit trace
  CONTRACT_BOOT_RECONCILE: 'contract_boot_reconcile',
  CONTRACT_BOOT_MIGRATE_ESCALATED: 'contract_boot_migrate_escalated', // ← NEW phase 1399: boot 时 escalated 残留 migrate
  CONTRACT_BOOT_MIGRATE_ARCHIVE_SKIPPED: 'contract_boot_migrate_archive_skipped', // ← NEW phase 1405: boot migrate 后 yaml load 失败、跳过 archive 留 forensics
  // NEW phase 153: boot reconcile JSON.parse silent catch 显式 audit emit (playbook §1)
  CONTRACT_BOOT_RECONCILE_SKIPPED: 'contract_boot_reconcile_skipped',
  // NEW phase 153: onboarding discovery progress.json parse failed silent skip 显式 audit
  CONTRACT_ONBOARDING_PROGRESS_PARSE_FAILED: 'contract_onboarding_progress_parse_failed',
  // phase 1362 (r140): contractDir → acquireLock TOCTOU race retry audit trace
  CONTRACT_DIR_RACE_RETRY: 'contract_dir_race_retry',
  // phase 1371 sub-2: archiveAndEmit partial recovery audit trace
  ARCHIVE_PARTIAL_RECOVERY_FAILED: 'contract_archive_partial_recovery_failed',
  ARCHIVE_RECOVERED: 'contract_archive_recovered',
  // phase 1371 sub-3: verification pipeline mutex race rejection audit trace
  VERIFICATION_PIPELINE_RACE_REJECTED: 'verification_pipeline_race_rejected',
  // phase 66 NEW: schema corruption isolation
  CONTRACT_FILE_ISOLATED: 'contract_file_isolated',
  CONTRACT_FILE_ISOLATION_FAILED: 'contract_file_isolation_failed',
  // phase 1235 B.3: typed emit empty contractId invariant
  TYPED_EMIT_INVARIANT_VIOLATION: 'contract_typed_emit_invariant_violation',
  // phase 1424: contract auditor 周期 LLM 对照 expectations 检查 + inbox 高优反馈
  CONTRACT_AUDIT_TRIGGERED: 'contract_audit_triggered',
  CONTRACT_AUDIT_DRIFT_DETECTED: 'contract_audit_drift_detected',
  CONTRACT_AUDIT_FEEDBACK_DELIVERED: 'contract_audit_feedback_delivered',
  // phase 188 Step A: archive 入口 status precondition violation
  CONTRACT_ARCHIVE_PRECONDITION_VIOLATED: 'contract_archive_precondition_violated',
  // phase 188 Step B: archive 内发现 non-terminal status entry
  CONTRACT_ARCHIVE_NONTERMINAL_DETECTED: 'contract_archive_nonterminal_detected',
  // phase 188 Step C: archive stale active 态 boot reconcile sweep
  CONTRACT_ARCHIVE_RECONCILE_STALE: 'contract_archive_reconcile_stale',
  CONTRACT_ARCHIVE_RECONCILE_FAILED: 'contract_archive_reconcile_failed',
  CONTRACT_ARCHIVE_RECONCILE_SUMMARY: 'contract_archive_reconcile_summary',
  // phase 197: archive_pending_recovery observer 扫到时归 audit、不投 motion inbox
  CONTRACT_ARCHIVE_RECOVERY_PENDING_OBSERVED: 'contract_archive_recovery_pending_observed',
  // Phase 230: contract create policy rejected
  CONTRACT_CREATE_POLICY_REJECTED: 'contract_create_policy_rejected',
  // phase 233 Step A: saveProgress 入口 schema invariant 违例
  CONTRACT_PROGRESS_INVARIANT_VIOLATED: 'contract_progress_invariant_violated',
  // phase 282 Step A: legacy status field ignored on load
  CONTRACT_LEGACY_STATUS_FIELD_IGNORED: 'contract_legacy_status_field_ignored',
  // phase 282 Step B: legacy contract_id field ignored on load
  CONTRACT_LEGACY_CONTRACT_ID_FIELD_IGNORED: 'contract_legacy_contract_id_field_ignored',
  CONTRACT_OBSERVER_STATE_INVARIANT_VIOLATED: 'contract_observer_state_invariant_violated',
  // phase 66 NEW (raw migration phase 272 Step C)
  MARK_CRASHED_GRACEFUL_FALLBACK: 'mark_crashed_graceful_fallback',
} as const;

/**
 * Phase 140: contract 业主声明 ID-naming map.
 *
 * SoT: contract 模块 own ContractId / SubtaskId 语义。
 */
export const CONTRACT_ID_NAMING: Readonly<Record<string, IdNamingEntry>> = {
  contract: {
    auditCol: 'contract_id',
    dialogMeta: 'contract_id',  // inbox metadata
    tsField: 'ContractId',      // brand type
    cliFlag: '--col contract_id',
  },
  subtask: {
    auditCol: 'subtask_id',
    dialogMeta: 'subtask_id',
    tsField: 'SubtaskId',       // brand type
    cliFlag: '--col subtask_id',
  },
} as const;


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 */
export const CONTRACT_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  contract_lock_cleared: 'audit',
  contract_lock_unlink_failed: 'audit',
  contract_lock_schema_invalid: 'audit',
  contract_lock_cleanup_failed: 'audit',
  contract_lock_retry: 'audit',
  contract_progress_schema_invalid: 'audit',
  contract_yaml_schema_invalid: 'audit',
  contract_observer_state_parse_failed: 'audit',
  contract_auditor_load_active_failed: 'audit',
  contract_progress_corrupted: 'audit',
  contract_archive_started: 'audit',
  contract_rollback_failed: 'audit',
  contract_rollback_incomplete: 'audit',
  contract_created: 'audit',
  contract_verification_started: 'audit',
  contract_updated: 'audit',
  contract_notify_failed: 'audit',
  contract_move_archive_failed: 'audit',
  contract_verification_inbox_failed: 'audit',
  contract_verification_reset_failed: 'audit',
  contract_verification_background_failed: 'audit',
  contract_complete_on_cancelled: 'audit',
  contract_verification_background_done: 'audit',
  contract_verification_script_started: 'audit',
  contract_subtask_duplicate_done: 'audit',
  contract_subtask_already_completed: 'audit',
  contract_unexpected_async_throw: 'audit',
  verification_passed: 'audit',
  contract_cancelled: 'audit',
  contract_crashed: 'audit',
  contract_completed: 'audit',
  contract_paused: 'audit',
  contract_resumed: 'audit',
  subtask_completed: 'audit',
  subtask_force_accepted: 'audit',
  verification_failed: 'audit',
  verification_timeout: 'audit',
  contract_verifier_failed: 'audit',
  contract_verifier_skipped: 'audit',
  contract_verifier_started: 'audit',
  contract_verifier_passed: 'audit',
  contract_verifier_result_parse_failed: 'audit',
  contract_observer_event_failed: 'audit',
  contract_system_closed: 'audit',
  contract_completed_handler_failed: 'audit',
  contract_event_collector_scan_failed: 'audit',
  contract_dir_scan_failed: 'audit',
  contract_observer_state_load_failed: 'audit',
  contract_observer_bootstrap_done: 'audit',
  contract_boot_reconcile: 'audit',
  contract_boot_migrate_escalated: 'audit',
  contract_boot_migrate_archive_skipped: 'audit',
  contract_boot_reconcile_skipped: 'audit',
  contract_onboarding_progress_parse_failed: 'audit',
  contract_dir_race_retry: 'audit',
  contract_archive_partial_recovery_failed: 'audit',
  mark_crashed_graceful_fallback: 'audit',
  contract_archive_recovered: 'audit',
  verification_pipeline_race_rejected: 'audit',
  contract_file_isolated: 'audit',
  contract_file_isolation_failed: 'audit',
  contract_typed_emit_invariant_violation: 'audit',
  contract_audit_triggered: 'audit',
  contract_audit_drift_detected: 'audit',
  contract_audit_feedback_delivered: 'audit',
  contract_archive_precondition_violated: 'audit',
  contract_archive_nonterminal_detected: 'audit',
  contract_archive_reconcile_stale: 'audit',
  contract_archive_reconcile_failed: 'audit',
  contract_archive_reconcile_summary: 'audit',
  contract_archive_recovery_pending_observed: 'audit',
  contract_progress_invariant_violated: 'audit',
  contract_legacy_status_field_ignored: 'audit',
  contract_legacy_contract_id_field_ignored: 'audit',
  contract_observer_state_invariant_violated: 'audit',
} as const;
