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
  GHOST_CALLBACK_AFTER_TURN_END: 'ghost_callback_after_turn_end',
} as const;

/**
 * React loop audit events (γ 同源复制 / phase375 裁决 2)
 *
 * 字符串值与 src/core/runtime/runtime-audit-events.ts 的 REACT_LOOP_AUDIT_EVENTS 等价 / 0 漂移。
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
