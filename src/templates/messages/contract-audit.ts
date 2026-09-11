/**
 * M06 inbox 文案：契约审计反馈（drift 条目 + 建议）。
 * 触发/接收者：ContractAuditor drift 检出 → 契约所属 claw（contract_audit_feedback，高优）。
 * 原 owner：core/contract（限流、去重、drift 内容仍归 auditor）。
 */

/** 单条 drift 行：`<n>. <what>（证据：<evidence>）`（序号由 owner 传入 0-based）。 */
export function contractAuditDriftLine(index: number, what: string, evidence: string): string {
  return `${index + 1}. ${what}（证据：${evidence}）`;
}

export function contractAuditFeedbackBody(driftLines: string, nextFocusSuggestion: string): string {
  return `看了你最近的活动，几个点：

${driftLines || '（auditor 标 drift 但未给具体条目）'}

建议：${nextFocusSuggestion || '（无）'}`;
}
