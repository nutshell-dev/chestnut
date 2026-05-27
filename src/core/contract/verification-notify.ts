/**
 * @module L4.ContractSystem.Verification.Notify
 * Notify helpers — safe wrapper + inbox writer + error writer
 */

import * as path from 'path';
import type { VerificationContext } from './verification-types.js';
import { notifyClaw } from '../../foundation/messaging/index.js';

import type { ContractId, SubtaskId } from './types.js';
import { formatErr } from '../../foundation/utils/format.js';
import { ToolTimeoutError } from '../../foundation/errors.js';
import type { LastFailedFeedback, AcceptanceFailedNotification } from './types.js';
import {
  emitContractNotifyFailed,
  emitContractEscalated,
  emitContractVerificationResetFailed,
} from './audit-emit.js';

type NotifyType = 'subtask_completed' | 'verification_failed' | 'contract_completed';

export function safeNotify(
  ctx: VerificationContext,
  type: NotifyType,
  data: Record<string, unknown>,
): void {
  try {
    ctx.onNotify?.(type, data);
  } catch (err) {
    emitContractNotifyFailed(
      ctx.audit,
      { notifyType: type, error: formatErr(err) },
    );
  }
}

export function writeVerificationInbox(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  verdict: 'passed' | 'rejected',
  allCompleted: boolean,
  feedback?: string,
  retryCount?: number,
): void {
  const extraFields: Record<string, string> = {
    contract_id: contractId,
    subtask_id: subtaskId,
    verdict,
  };
  if (retryCount !== undefined) extraFields.retry_count = String(retryCount);

  let body: string;
  if (verdict === 'passed') {
    body = allCompleted
      ? `Subtask ${subtaskId} accepted. All subtasks complete!`
      : `Subtask ${subtaskId} accepted.`;
  } else {
    body = feedback || 'No feedback provided';
  }

  const clawforumRoot = path.dirname(path.dirname(ctx.clawDir));
  notifyClaw(ctx.fs, clawforumRoot, ctx.clawId, {
    type: verdict === 'passed' ? 'verification_result' : 'verification_rejection',
    source: 'contract_system',
    to: ctx.clawId,
    priority: verdict === 'rejected' ? 'high' : 'normal',
    body,
    extraFields,
  }, ctx.audit);
}

export async function writeVerificationError(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  error: unknown,
): Promise<void> {
  const errorMsg = formatErr(error);
  const cause: LastFailedFeedback['cause'] =
    error instanceof ToolTimeoutError ? 'subagent_timeout' : 'programming_bug';
  const feedbackText =
    cause === 'subagent_timeout'
      ? `Acceptance verifier timed out after ${(error as ToolTimeoutError).context?.timeoutMs ?? '?'}ms. 资源 / 网络问题 / 重试可能修复。Error: ${errorMsg}`
      : `Acceptance verification crashed (system bug). Error: ${errorMsg}. 修代码后再 retry。`;

  const clawforumRoot = path.dirname(path.dirname(ctx.clawDir));
  notifyClaw(ctx.fs, clawforumRoot, ctx.clawId, {
    type: 'verification_error',
    source: 'contract_system',
    to: ctx.clawId,
    priority: 'high',
    body: `Acceptance verification failed with error: ${errorMsg}`,
    idPrefix: 'verification_error',
    extraFields: {
      contract_id: contractId,
      subtask_id: subtaskId,
    },
  }, ctx.audit);

  try {
    await ctx.withProgressLock(contractId, async () => {
      const progress = await ctx.getProgress(contractId);
      const subtask = progress.subtasks[subtaskId];
      if (subtask && subtask.status === 'in_progress') {
        subtask.status = 'todo';
        subtask.retry_count = (subtask.retry_count || 0) + 1;
        subtask.last_failed_feedback = { feedback: feedbackText, cause };

        const contractYaml = await ctx.loadContractYaml(contractId);
        const maxRetries = contractYaml.escalation?.max_retries ?? 3;

        if (subtask.retry_count >= maxRetries) {
          subtask.escalated_at = new Date().toISOString();
          subtask.status = 'escalated';
          await ctx.saveProgress(contractId, progress);
          emitContractEscalated(
            ctx.audit,
            {
              contractId,
              subtaskId,
              retryCount: subtask.retry_count,
              claw: ctx.clawId,
              context: 'writeVerificationError.reset',
            },
          );
        } else {
          await ctx.saveProgress(contractId, progress);
        }

        safeNotify(ctx, 'verification_failed', {
          contract_id: contractId,
          subtask_id: subtaskId,
          cause,
          feedback: feedbackText,
          retry_count: subtask.retry_count,
          max_retries: maxRetries,
        } satisfies AcceptanceFailedNotification);
      }
    });
  } catch (e) {
    emitContractVerificationResetFailed(
      ctx.audit,
      { context: 'ContractSystem._writeVerificationError.resetStatus', error: formatErr(e) },
    );
  }
}
