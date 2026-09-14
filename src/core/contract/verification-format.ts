/**
 * @module L4.ContractSystem.Verification.Format
 * Format helpers — pure functions
 */

import type { ProgressData, SubtaskId } from './types.js';
import { structuredRejectionFeedback } from '../../templates/messages/index.js';

export function formatValidIds(progress: ProgressData): string {
  return Object.keys(progress.subtasks).join(', ');
}

/**
 * phase 1829: 固定文案与纯布局委托 templates/messages；兼容入口签名不变。
 * subtaskId 身份由通知身份行承载，结构化反馈不再重复 `## 验收失败 — id` 标题。
 */
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
  void subtaskId;
  return structuredRejectionFeedback({
    subtaskDesc,
    reason,
    issues,
    retryCount,
    maxRetries,
    verificationType,
    verificationFile,
  });
}
