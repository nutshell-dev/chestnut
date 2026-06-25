/**
 * @module L3.AgentExecutor
 *
 * AgentExecutor-owned audit event names.
 * TOOL_CALL_INPUT moved here from Runtime in phase 706 (audit responsibility
 * per-step owner: AgentExecutor knows the current step count).
 */

export const AGENT_EXECUTOR_AUDIT_EVENTS = {
  TOOL_CALL_INPUT: 'agent_tool_call_input',
  STEP_COMPLETED: 'agent_step_completed',    // NEW phase 730
  TOOL_RESULT: 'agent_tool_result',          // NEW phase 730
} as const;
