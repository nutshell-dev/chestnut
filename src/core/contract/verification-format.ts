/**
 * @module L4.ContractSystem.Verification.Format
 * Format helpers — pure functions
 */

import type { ProgressData, SubtaskId } from './types.js';

export function formatValidIds(progress: ProgressData): string {
  return Object.keys(progress.subtasks).join(', ');
}

export function formatRejectionFeedback(
  subtaskId: SubtaskId,
  subtaskDesc: string,
  reason: string,
  issues: string[],
  retryCount: number,
  maxRetries: number,
  verificationType: string,
  verificationFile: string,
): string {
  const issuesList = issues.length > 0
    ? issues.map(i => `- ${i}`).join('\n')
    : '- (未提供具体问题)';

  return [
    `## 验收失败 — ${subtaskId}`,
    '',
    `**子任务：** ${subtaskDesc}`,
    '',
    '**失败原因：**',
    reason,
    '',
    '**需要修正的问题：**',
    issuesList,
    '',
    `**验收标准：** ${verificationType} (${verificationFile})`,
    '',
    `已失败 ${retryCount}/${maxRetries} 次。`,
  ].join('\n');
}
