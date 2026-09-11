/**
 * M03 inbox 文案：验证结果/拒绝/错误/force-accept 通知与重试反馈文本。
 * 触发/接收者：ContractSystem 验证流水线 → 契约所属 claw。
 * 原 owner：core/contract（verification-notify / verification）。
 */

export function subtaskAcceptedMessage(subtaskId: string, allCompleted: boolean): string {
  return allCompleted
    ? `Subtask ${subtaskId} accepted. All subtasks complete!`
    : `Subtask ${subtaskId} accepted.`;
}

/** rejection 正文：沿用原 `feedback || fallback` 语义（空串视为缺省）。 */
export function verificationRejectionMessage(feedback: string | undefined): string {
  return feedback || 'No feedback provided';
}

export function forceAcceptMessage(input: {
  subtaskId: string;
  retryCount: number;
  allCompleted: boolean;
  lastFeedback?: string;
}): string {
  const summary = input.lastFeedback ? `\n⚠ last_failure: ${input.lastFeedback}` : '';
  return input.allCompleted
    ? `Subtask ${input.subtaskId} force-accepted after ${input.retryCount} attempts. All subtasks complete!${summary}`
    : `Subtask ${input.subtaskId} force-accepted after ${input.retryCount} attempts.${summary}`;
}

export function verificationErrorMessage(errorMsg: string): string {
  return `Acceptance verification failed with error: ${errorMsg}`;
}

export function verificationTimeoutFeedback(timeoutMs: string | number, errorMsg: string): string {
  return `Acceptance verifier timed out after ${timeoutMs}ms. 资源 / 网络问题 / 重试可能修复。Error: ${errorMsg}`;
}

export function verificationCrashedFeedback(errorMsg: string): string {
  return `Acceptance verification crashed (system bug). Error: ${errorMsg}. 修代码后再 retry。`;
}
