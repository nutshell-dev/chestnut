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
