/**
 * @module L4.ContractSystem.Verification.Notify
 * Notify helpers — safe wrapper + inbox writer + error writer
 */

import type { VerificationContext } from './verification-types.js';
import { notifyClaw } from '../../foundation/messaging/index.js';
import { makeClawforumRoot } from '../../foundation/identity/index.js';
import { getClawforumRoot } from '../../foundation/paths.js';

import type { ContractId } from '../../foundation/identity/index.js';
import type { SubtaskId } from './types.js';
import { formatErr } from '../../foundation/utils/format.js';
import { ToolTimeoutError } from '../../foundation/errors.js';
import type { LastFailedFeedback, AcceptanceFailedNotification } from './types.js';
import {
  emitContractNotifyFailed,
  emitContractVerificationResetFailed,
  emitSubtaskForceAccepted,
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

  const clawforumRoot = ctx.clawforumRoot ?? makeClawforumRoot(getClawforumRoot());
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
): Promise<{ archived?: boolean }> {
  const errorMsg = formatErr(error);
  const cause: LastFailedFeedback['cause'] =
    error instanceof ToolTimeoutError ? 'subagent_timeout' : 'programming_bug';
  const feedbackText =
    cause === 'subagent_timeout'
      ? `Acceptance verifier timed out after ${(error as ToolTimeoutError).context?.timeoutMs ?? '?'}ms. 资源 / 网络问题 / 重试可能修复。Error: ${errorMsg}`
      : `Acceptance verification crashed (system bug). Error: ${errorMsg}. 修代码后再 retry。`;

  const clawforumRoot = ctx.clawforumRoot ?? makeClawforumRoot(getClawforumRoot());
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

  let result: { archived?: boolean } = {};
  try {
    await ctx.withProgressLock(contractId, async () => {
      const progress = await ctx.getProgress(contractId);
      const subtask = progress.subtasks[subtaskId];
      if (subtask && subtask.status === 'in_progress') {
        subtask.status = 'todo';
        subtask.retry_count = (subtask.retry_count || 0) + 1;
        subtask.last_failed_feedback = { feedback: feedbackText, cause };

        const contractYaml = await ctx.loadContractYaml(contractId);
        const maxAttempts = contractYaml.verification_attempts ?? 3;

        if (subtask.retry_count >= maxAttempts) {
          // 强制接受：timeout/crash 路径达上限同样 force_accepted
          subtask.status = 'completed';
          subtask.completed_at = new Date().toISOString();
          subtask.force_accepted = true;
          await ctx.saveProgress(contractId, progress);
          emitSubtaskForceAccepted(ctx.audit, {
            contractId, subtaskId, retryCount: subtask.retry_count, claw: ctx.clawId,
          });
          safeNotify(ctx, 'subtask_completed', {
            contract_id: contractId, subtask_id: subtaskId, force_accepted: true,
          });

          const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
          if (allCompleted && progress.status !== 'completed') {
            progress.status = 'completed';
            await ctx.saveProgress(contractId, progress);
            // archiveAndEmit 由 caller（runVerificationInBackground catch）在 withProgressLock 外调用
            result = { archived: false };
            return;
          }
          return;
        }
        await ctx.saveProgress(contractId, progress);
        safeNotify(ctx, 'verification_failed', {
          contract_id: contractId,
          subtask_id: subtaskId,
          cause,
          feedback: feedbackText,
          retry_count: subtask.retry_count,
          max_attempts: maxAttempts,
        } satisfies AcceptanceFailedNotification);
      }
    });
  } catch (e) {
    emitContractVerificationResetFailed(
      ctx.audit,
      { context: 'ContractSystem._writeVerificationError.resetStatus', error: formatErr(e) },
    );
  }
  return result;
}

