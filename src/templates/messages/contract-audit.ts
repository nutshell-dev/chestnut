/**
 * M06 inbox 文案：契约审计反馈（身份 + 来源 + 依据 + 可选建议）。
 * 触发/接收者：ContractAuditor drift 检出 → 契约所属 claw（contract_audit_feedback，高优）。
 * 原 owner：core/contract（有效性判定、限流、去重、材料来源选择仍归 auditor；
 * 模板仅呈现 owner 已选定的事实，不做解析/查询/投递）。
 * phase 1830：正文自含契约身份与材料快照性质；无依据的审阅结果不进入本模板。
 */

/**
 * 单条 drift 行：`<n>. <what>\n   依据：<evidence>`（序号由 owner 传入 0-based）。
 * what/evidence 为模型原文（owner 已校验非空白），模板不修饰、不推断。
 */
export function contractAuditDriftLine(index: number, what: string, evidence: string): string {
  return `${index + 1}. ${what}\n   依据：${evidence}`;
}

/** contractAuditFeedbackBody 入参：owner 已选定/校验的最小标量。 */
export interface ContractAuditFeedbackBodyInput {
  contractId: string;
  /** 契约标题；空字符串时正文仅呈现 ID，不造名称。 */
  contractTitle: string;
  /** 逐条编号排版后的 drift 行（owner 经 contractAuditDriftLine 生成、join）。 */
  driftLines: string;
  /** 整体建议；缺省/空/空白时省略建议节（不显示「（无）」占位）。 */
  suggestion?: string;
  /** owner 按实际输入选择：本次审阅材料是否包含近期对话片段。 */
  includesRecentMessages: boolean;
  /** 材料采集时刻 ISO（owner 在采集时捕获；不用投递时刻冒充）。 */
  collectedAt: string;
}

export function contractAuditFeedbackBody(input: ContractAuditFeedbackBodyInput): string {
  const { contractId, contractTitle, driftLines, suggestion, includesRecentMessages, collectedAt } = input;
  const header = contractTitle
    ? `契约执行审阅建议｜${contractTitle}（${contractId}）`
    : `契约执行审阅建议｜${contractId}`;
  const materials = includesRecentMessages
    ? '本次采集的契约要求、进度、活动摘要及提供的近期对话片段'
    : '本次采集的契约要求、进度和活动摘要';
  const suggestionSection = suggestion && suggestion.trim()
    ? `\n\n建议：${suggestion}`
    : '';
  return `${header}

自动审阅依据${materials}（材料采集于 ${collectedAt}），发现以下可能的偏离。活动摘要可能包含未标注契约归属的工具活动。

${driftLines}${suggestionSection}

请结合当前进度判断这些问题是否仍然存在，对仍存在的问题调整后续执行。`;
}
