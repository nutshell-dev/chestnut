// src/foundation/tools/audit-events.ts
// phase 1406: tool caller-access governance (M#8 minimal界面 + M#9 显式 + 编译可检)

/**
 * Emitted by ToolExecutor when a tool calls `ctx.getCallerSnapshot()`
 * without declaring `accessesCaller: true` on its Tool definition, OR
 * when declared but ExecContext was constructed without a bound provider.
 *
 * Payload columns (TSV): tool_name, tool_use_id, reason=<accessesCaller_not_declared|provider_not_bound>
 *
 * Anchored in `design/modules/l2_tool_protocol.md §A.invariant-? (phase 1406)`.
 */
export const TOOL_AUDIT_EVENTS = {
  TOOL_CALLER_ACCESS_VIOLATION: 'tool_caller_access_violation',
  INVARIANT_VIOLATION: 'tools_invariant_violation',   // phase 66 NEW
  TOOL_NOT_FOUND: 'tool_not_found',                    // phase 70 NEW
  TOOL_INVALID_INPUT: 'tool_invalid_input',            // phase 70 NEW
  // NEW phase 272 Step A: raw audit emit migration to const SoT
  TOOL_ASYNC_REJECTED: 'tool_async_rejected',
  TOOL_ASYNC_START: 'tool_async_start',
  TOOL_EXEC_RACE_LOSER: 'tool_exec_race_loser',
  STOP_REQUESTED: 'stop_requested',
} as const;


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 */
export const TOOLS_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  tool_caller_access_violation: 'audit',
  tools_invariant_violation: 'audit',
  tool_not_found: 'audit',
  tool_invalid_input: 'audit',
  // NEW phase 272 Step A
  tool_async_rejected: 'audit',
  tool_async_start: 'audit',
  tool_exec_race_loser: 'audit',
  stop_requested: 'audit',
} as const;
