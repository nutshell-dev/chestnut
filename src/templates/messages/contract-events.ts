/**
 * M05 inbox 文案：契约 archive 事件的正文行与事件间组合。
 * 触发/接收者：ContractSystem event-collector/contract-observer → motion inbox（contract_events / contract_cancelled，高优）。
 * 原 owner：core/contract（schema 解析、状态分支、已完成过滤、hasFailure 仍在 owner）。
 */

/** 事件标题行：`[<label>] claw=<clawId> contract=<contractName>`。 */
export function contractEventHeader(label: string, clawId: string, contractName: string): string {
  return `[${label}] claw=${clawId} contract=${contractName}`;
}

export function contractEventTitleLine(title: string): string {
  return `  title: ${title}`;
}

export function contractEventGoalLine(goal: string): string {
  return `  goal: ${goal}`;
}

export function contractEventReasonLine(reason: string): string {
  return `  reason: ${reason}`;
}

export function contractEventEvidenceRefLine(evidenceRef: string): string {
  return `  evidence_ref: ${evidenceRef}`;
}

export function contractEventCauseLine(cause: string): string {
  return `  cause: ${cause}`;
}

export function contractEventSubtasksHeading(kind: 'completed' | 'before-cancel' | 'before-crash'): string {
  switch (kind) {
    case 'completed':
      return '  subtasks:';
    case 'before-cancel':
      return '  subtasks (completed before cancel):';
    case 'before-crash':
      return '  subtasks (completed before crash):';
  }
}

export function contractEventSubtaskEvidenceLine(subtaskId: string, evidence: string): string {
  return `    [${subtaskId}] ${evidence}`;
}

export function contractEventSubtaskIdLine(subtaskId: string): string {
  return `    [${subtaskId}]`;
}

export function contractEventLastFailureLine(feedback: string): string {
  return `      ⚠ last_failure: ${feedback}`;
}

/** 逐事件正文按 `\n\n` 组合为一条 inbox body。 */
export function contractEventsBody(events: readonly string[]): string {
  return events.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* phase 1832：契约完成通知专用呈现（取消/失败/crashed 分支不变）。     */
/* 措辞单源：自家（M04 adapter）与 observer（M05 event-collector）两路  */
/* 共用以下纯函数；只呈现数据源已有事实，不反推质量结论、不补造细节。   */
/* ------------------------------------------------------------------ */

/** 完成终态 + 对象行：`契约流程已完成｜标题（ID）`；标题空只显示 ID。 */
export function contractCompletedStateLine(title: string, contractId: string): string {
  return title ? `契约流程已完成｜${title}（${contractId}）` : `契约流程已完成｜${contractId}`;
}

/** 执行者行（契约所属 claw；observer 路即被观察 claw）。 */
export function contractCompletedExecutorLine(clawId: string): string {
  return `执行者：${clawId}`;
}

/** 原目标行（goal 原文保留，调用方仅在非空时调用）。 */
export function contractCompletedGoalLine(goal: string): string {
  return `原目标：${goal}`;
}

/** 完成时间行（已有且非空时由调用方调用）。 */
export function contractCompletedTimeLine(completedAt: string): string {
  return `完成时间：${completedAt}`;
}

/** 已完成子任务小节标题。 */
export function contractCompletedSubtasksHeading(): string {
  return '已完成子任务：';
}

/**
 * observer 路子任务材料行：evidence 原文保留；未记录材料时明确「未记录提交材料」，
 * 不冒称无工作成果。
 */
export function contractCompletedMaterialLine(subtaskId: string, evidence: string): string {
  return evidence
    ? `  [${subtaskId}] 执行者提交材料：${evidence}`
    : `  [${subtaskId}] 执行者提交材料：未记录提交材料`;
}

/**
 * 放行中性注记（子任务续行）：force_accepted 只表示按流程放行记为完成，
 * 不表示验收通过；缺省/false 不反推质量通过（调用方据此决定是否追加）。
 */
export function contractCompletedForceAcceptedNoteLine(): string {
  return '    完成方式：按流程放行记为完成；该标记不表示验收通过';
}

/**
 * observer 路历史验收反馈行：last_failed_feedback 原文保留；明示是该子任务保留的
 * 历史记录，不推测对应最终尝试、不要求重做。
 */
export function contractCompletedHistoryFeedbackLine(feedback: string): string {
  return `    历史验收反馈（该子任务保留的历史记录，不对应最终验收结论）：${feedback}`;
}

/* ------------------------------------------------------------------ */
/* phase 1833：契约取消通知专用呈现（completed/failed/crashed 分支不变）。*/
/* 只呈现 owner 已选择的事实行；模板不解析 checkpoint、不判断来源。     */
/* ------------------------------------------------------------------ */

/** 取消终态 + 对象行：`契约已取消｜标题（ID）`；标题空只显示 ID。 */
export function contractCancelledStateLine(title: string, contractId: string): string {
  return title ? `契约已取消｜${title}（${contractId}）` : `契约已取消｜${contractId}`;
}

/** 自家通知取消原因行（typed event 原 reason，调用方保证非空白）。 */
export function contractCancelledReasonLine(reason: string): string {
  return `取消原因：${reason}`;
}

/** 自家通知空原因行：取消请求未填写原因。 */
export function contractCancelledEmptyReasonLine(): string {
  return '取消请求未填写原因';
}

/** observer 路：取消请求原因小节标题（记录中的请求，不冒称生效原因）。 */
export function contractCancelledRequestsHeading(): string {
  return '记录中的取消请求原因：';
}

/** observer 路：单条取消请求原因（逐条完整保留不去重）；空白明示该条未填写。 */
export function contractCancelledRequestReasonLine(reason: string): string {
  return reason.trim() ? `  - ${reason}` : '  - （该条未填写原因）';
}

/** observer 路：部分原因记录读取失败注记（详细问题走真实审计）。 */
export function contractCancelledPartialReadNoteLine(): string {
  return '  部分原因记录读取失败，以上为已读取部分';
}

/** observer 路：legacy checkpoint 取消原因行；前缀后为空则说明未取得原因。 */
export function contractCancelledLegacyReasonLine(reason: string): string {
  return reason.trim()
    ? `历史检查点记录的取消原因：${reason}`
    : '历史检查点有取消标记，本次未取得取消原因记录';
}

/** observer 路：未取得原因统一措辞（不断言根本没有原因）。 */
export function contractCancelledNoReasonLine(): string {
  return '本次未取得取消原因记录';
}

/** observer 路：非取消 checkpoint 单列完整保留，不当原因。 */
export function contractCancelledCheckpointLine(checkpoint: string): string {
  return `历史检查点记录：${checkpoint}`;
}

/** observer 路：取消前已完成子任务小节标题（无已完成子任务时调用方不渲染本小节）。 */
export function contractCancelledSubtasksHeading(): string {
  return '取消前已完成子任务：';
}

/** observer 路：取消前已完成子任务 ID 行。 */
export function contractCancelledSubtaskIdLine(subtaskId: string): string {
  return `  [${subtaskId}]`;
}
