// src/core/runtime/runtime-audit-events.ts
/**
 * Runtime audit event names (含 LLM Response anomalies + Session + AsyncTaskSystem + Snapshot + Inbox + Tool + Outbox).
 *
 * Module-owned event namespace per H1 design (phase336 / r36 α 决策 / H1 收官).
 * 字符串值与起步态 events.ts RUNTIME_* + LLM_* 系列等价 / 0 漂移。
 *
 * 合并理由：events.ts 中 Runtime + LLM Response 是 2 分组 / 但 caller 同为 runtime.ts /
 * 1 文件聚合更简洁（M#3 资源唯一归属：runtime caller 模块 own）。
 */

export const RUNTIME_AUDIT_EVENTS = {
  // SESSION_*
  SESSION_LOADED: 'session_loaded',
  SESSION_REPAIRED: 'session_repaired',
  // TASK_SYSTEM_*
  TASK_SYSTEM_INIT_FAILED: 'task_system_init_failed',
  TASK_SYSTEM_START_DISPATCH_FAILED: 'task_system_start_dispatch_failed',
  // SNAPSHOT_*
  SNAPSHOT_COMMIT_FAILED: 'snapshot_commit_failed',
  SNAPSHOT_COMMIT_UNCATEGORIZED: 'snapshot_commit_uncategorized',
  // INBOX_*
  INBOX_INJECT: 'inbox_inject',
  INBOX_UNADDRESSED: 'inbox_unaddressed',
  INBOX_UNKNOWN_TYPE: 'runtime_inbox_unknown_type',
  INBOX_DRAIN_FAILED: 'runtime_inbox_drain_failed',
  INBOX_DRAIN_ERRORS: 'runtime_inbox_drain_errors',
  // INITIALIZE phase failures (phase 454: 替代 Runtime 借 ASSEMBLE_FAILED)
  INBOX_INIT_FAILED: 'runtime_inbox_init_failed',
  SESSION_REPAIR_FAILED: 'runtime_session_repair_failed',
  // phase 521: regime switch audit event
  REGIME_SWITCH: 'regime_switch',
  REGIME_SWITCH_COMMITTED: 'regime_switch_committed', // NEW phase1108
  // phase 539: regime switch failed audit event
  REGIME_SWITCH_FAILED: 'regime_switch_failed',
  REGIME_SWITCH_HARD_FAIL: 'regime_switch_hard_fail',
  // phase 598: optional section read failed audit event
  OPTIONAL_SECTION_READ_FAILED: 'runtime_optional_section_read_failed',
  // phase 446 (review): onStepComplete 内 fire-and-forget maybeAuditStep 防御 catch
  MAYBE_AUDIT_STEP_FAILED: 'runtime_maybe_audit_step_failed',
  // phase 521 (review-round4 N4-Core-H2): processBatch ack/nack per-handle atomicity
  // 防 ack/nack 抛错 cascade 到 turn-level catch 触发 rollback + duplicate delivery
  INBOX_ACK_FAILED: 'runtime_inbox_ack_failed',
  INBOX_NACK_FAILED: 'runtime_inbox_nack_failed',
  // phase 555: _runReact 入口 contractManager.loadActive() 失败 fallback emit；
  // 拆 phase 544 misuse 的 MAYBE_AUDIT_STEP_FAILED（语义专属 onStepComplete maybeAuditStep）
  TURN_CONTRACT_ID_CACHE_FAILED: 'runtime_turn_contract_id_cache_failed',
  // Phase 1218 Step A: Runtime dialog mutation authority violations
  DIALOG_OPERATION_CONCURRENT: 'runtime_dialog_operation_concurrent',
  DIALOG_OPERATION_WHILE_STOPPING: 'runtime_dialog_operation_while_stopping',
  DIALOG_OPERATION_JOIN_FAILED: 'runtime_dialog_operation_join_failed',
  // NEW (raw migration phase 272 Step C)
  GUIDANCE_COMPOSER_FAILED: 'guidance_composer_failed',
  // phase 320: LLM config hot-reload via inbox `reload_llm_config` message
  LLM_RELOADED: 'runtime_llm_reloaded',
  LLM_RELOAD_FAILED: 'runtime_llm_reload_failed',
  LLM_RELOAD_SKIPPED: 'runtime_llm_reload_skipped',
  // phase 1440: ContextInjector context load failure（AGENTS.md / MEMORY.md / contract）
  CONTEXT_INJECT_LOAD_FAILED: 'context_inject_load_failed',
  // phase 690: Runtime 反应式 trim+retry 触发 - LLM 返 context-exceeded 后 trim + 同 turn 重发
  REACTIVE_TRIM_TRIGGERED: 'runtime_reactive_trim_triggered',
  REACTIVE_TRIM_EXHAUSTED: 'runtime_reactive_trim_exhausted',
} as const;

/**
 * React loop audit events (γ 同源复制 / phase375 裁决 2)
 *
 * 字符串值与 src/core/subagent/audit-events.ts 的 REACT_LOOP_AUDIT_EVENTS 等价 / 0 漂移。
 * 不抽共享层文件（避免新增模块层级 / M#5 反向）。
 */
export const REACT_LOOP_AUDIT_EVENTS = {
  TURN_START: 'turn_start',
  TURN_END: 'turn_end',
  TURN_INTERRUPTED: 'turn_interrupted',
  TURN_ERROR: 'turn_error',
  LLM_CALL: 'llm_call',
  LLM_ERROR: 'llm_error',
} as const;

/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 */
export const RUNTIME_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  guidance_composer_failed: 'audit',
  // phase 553 (back-fill phase 521 / 446): 业主声明 file 归属
  runtime_inbox_ack_failed: 'audit',
  runtime_inbox_nack_failed: 'audit',
  runtime_inbox_drain_errors: 'audit',
  runtime_maybe_audit_step_failed: 'audit',
  runtime_turn_contract_id_cache_failed: 'audit',
  runtime_reactive_trim_triggered: 'audit',  // phase 690
  runtime_reactive_trim_exhausted: 'audit',  // phase 690
  context_inject_load_failed: 'audit',  // phase 1440
} as const;
