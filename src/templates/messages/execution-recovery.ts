/**
 * M01 inbox 文案：execution_recovery 执行提醒投递。
 * 触发/接收者：EventLoop 停滞恢复 → 本 claw 自家 inbox（高优）。
 * 原 owner：core/event-loop。
 * Phase 1845: 正文只提供当次唤醒所需信息——检查时所见（契约仍活跃、
 * 一段时间未观察到新的执行活动）与唤醒用途（继续该契约尚未完成的工作）。
 * 只陈述「未观察到」，不声称没有任何活动、不声称契约已失败或已恢复；
 * 调度次数不写入正文（仍在 record/delivery/审计中保留）。
 * Phase 1989（部分取代 1845「正文不写次数」）：第 1 次正文不变；第 N≥2 次
 * 写明连续提醒次数与行动要求——纯思考/文本不算行动（方案 B：仅 tool_call
 * 前进清零计数），提醒 agent 必须调用工具推进契约。
 */
export function executionRecoveryMessage(contractId: string, attempt = 1): string {
  const base =
    `系统在检查时发现契约 ${contractId} 仍活跃，且一段时间未观察到新的执行活动。`
    + `本消息用于唤醒你继续该契约尚未完成的工作。`;
  if (attempt <= 1) return base;
  const repeats = attempt - 1;
  return `系统在检查时发现契约 ${contractId} 仍活跃。`
    + `这是连续第 ${attempt} 次提醒（前 ${repeats} 次提醒后未观察到任何工具调用）。`
    + `仅输出思考或文本不会推进契约；请立即调用工具执行该契约未完成的工作。`;
}
