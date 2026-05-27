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
  // 原有
  PROCESS_BATCH_FAILED: 'runtime_process_batch_failed',
  LLM_EMPTY_RESPONSE: 'llm_empty_response',
  LLM_UNKNOWN_STOP_REASON: 'llm_unknown_stop_reason',
  LLM_UNPARSEABLE_TOOL_USE: 'llm_unparseable_tool_use',
  TOOL_INPUT_PARSE_FAILED: 'tool_input_parse_failed',   // ← NEW (phase 850 β refactor / r108 F fork F2.2)
  TOOL_EXECUTION_FAILED: 'tool_execution_failed',       // ← NEW (phase 850 β refactor / r108 F fork F2.4)
  // SESSION_*
  SESSION_LOADED: 'session_loaded',
  SESSION_REPAIRED: 'session_repaired',
  SESSION_ARCHIVE_FAILED: 'session_archive_failed',
  // TASK_SYSTEM_*
  TASK_SYSTEM_INIT_FAILED: 'task_system_init_failed',
  TASK_SYSTEM_START_DISPATCH_FAILED: 'task_system_start_dispatch_failed',
  // SNAPSHOT_*
  SNAPSHOT_COMMIT_FAILED: 'snapshot_commit_failed',
  SNAPSHOT_COMMIT_UNCATEGORIZED: 'snapshot_commit_uncategorized',
  // INBOX_*
  INBOX_HANDLER_FAILED: 'inbox_handler_failed',
  INBOX_INJECT: 'inbox_inject',
  INBOX_UNADDRESSED: 'inbox_unaddressed',
  INBOX_UNKNOWN_TYPE: 'runtime_inbox_unknown_type',
  INBOX_DRAIN_FAILED: 'runtime_inbox_drain_failed',
  // TOOL / OUTBOX
  TOOL_RESULT: 'tool_result',
  OUTBOX_WRITE_FAILED: 'outbox_write_failed',
  // INITIALIZE phase failures (phase 454: 替代 Runtime 借 ASSEMBLE_FAILED)
  INBOX_INIT_FAILED: 'runtime_inbox_init_failed',
  SESSION_REPAIR_FAILED: 'runtime_session_repair_failed',
  // phase 521: regime switch audit event
  REGIME_SWITCH: 'regime_switch',
  REGIME_SWITCH_COMMITTED: 'regime_switch_committed', // NEW phase1108
  // phase 539: regime switch failed audit event
  REGIME_SWITCH_FAILED: 'regime_switch_failed',
  // phase 598: optional section read failed audit event
  OPTIONAL_SECTION_READ_FAILED: 'runtime_optional_section_read_failed',
  // phase 845: step executor callback failed audit event
  STEP_EXECUTOR_CALLBACK_FAILED: 'step_executor_callback_failed',
  // phase 1274: max_tokens stop handler prebuilt-only final path
  MAX_TOKENS_PREBUILT_ONLY_FINAL: 'max_tokens_prebuilt_only_final',
  // phase 1274: max_tokens stop handler empty assistant skipped
  MAX_TOKENS_ASSISTANT_EMPTY_SKIPPED: 'max_tokens_assistant_empty_skipped',
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
