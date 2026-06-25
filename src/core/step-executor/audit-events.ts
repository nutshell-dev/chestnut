/**
 * StepExecutor audit event names.
 *
 * Module-owned event namespace per H1 design.
 */
export const STEP_EXECUTOR_AUDIT_EVENTS = {
  INVARIANT_VIOLATION: 'step_executor_invariant_violation',  // phase 66 NEW
  PARTIAL_ASSISTANT_DISCARDED: 'partial_assistant_discarded',
  LLM_EMPTY_RESPONSE: 'llm_empty_response',
  LLM_UNKNOWN_STOP_REASON: 'llm_unknown_stop_reason',
  LLM_UNPARSEABLE_TOOL_USE: 'llm_unparseable_tool_use',
  TOOL_INPUT_PARSE_FAILED: 'tool_input_parse_failed',
  TOOL_EXECUTION_FAILED: 'tool_execution_failed',
  STEP_EXECUTOR_CALLBACK_FAILED: 'step_executor_callback_failed',
  MAX_TOKENS_PREBUILT_ONLY_FINAL: 'max_tokens_prebuilt_only_final',
  MAX_TOKENS_ASSISTANT_EMPTY_SKIPPED: 'max_tokens_assistant_empty_skipped',
  MAX_TOKENS_STATE_A_ORPHAN_DROP: 'max_tokens_state_a_orphan_drop',
} as const;
