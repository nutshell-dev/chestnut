// src/foundation/command-tool/audit-events.ts
// Phase 1473: exec tool 拒绝 motion-chain self-kill (chestnut stop / motion stop)
//   触发：motion 通过 exec 跑 `chestnut stop` → in-flight tool_use_result 丢
//        → motion 重启回到悬挂 tool_use → 再发起 → 死循环

export const COMMAND_TOOL_AUDIT_EVENTS = {
  EXEC_MOTION_SELF_KILL_BLOCKED: 'exec_motion_self_kill_blocked',
  // NEW phase 272 Step B: raw audit emit migration to const SoT
  OVERFLOW_PERSIST_FAILED: 'overflow_persist_failed',
  // NEW phase 1269 Step D: structured exec termination conclusion (L1 facts)
  EXEC_TERMINATION: 'exec_termination',
} as const;

/**
 * Phase 159 业主声明 file 归属（phase 122 §5.A + §6.7）.
 */
export const COMMAND_TOOL_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  overflow_persist_failed: 'audit',
  exec_termination: 'audit',
} as const;
