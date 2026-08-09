// src/foundation/command-tool/audit-events.ts
// Exec guard 是装配注入的通用提交协议；具体 guard 语义由 guardKind 字段表达。

export const COMMAND_TOOL_AUDIT_EVENTS = {
  EXEC_GUARD_REJECTED: 'exec_guard_rejected',
  // NEW phase 272 Step B: raw audit emit migration to const SoT
  OVERFLOW_PERSIST_FAILED: 'overflow_persist_failed',
  // NEW phase 1269 Step D: structured exec termination conclusion (L1 facts)
  EXEC_TERMINATION: 'exec_termination',
} as const;

/**
 * Phase 159 业主声明 file 归属（phase 122 §5.A + §6.7）.
 */
export const COMMAND_TOOL_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  exec_guard_rejected: 'audit',
  overflow_persist_failed: 'audit',
  exec_termination: 'audit',
} as const;
