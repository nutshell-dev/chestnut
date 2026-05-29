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
} as const;
