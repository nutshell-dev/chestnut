/**
 * @module L4.ContractSystem.Verification.Notify
 * Notify helpers — safe wrapper + inbox writer + error writer
 */

import type { VerificationContext } from './verification-types.js';
import type { ContractId } from './types.js';
import type { SubtaskId } from './types.js';
import * as path from 'path';
import { formatErr } from '../../foundation/node-utils/index.js';
import { activeContainerDir } from './locations.js';
import { ToolError, ToolTimeoutError } from '../../foundation/tools/errors.js';
import { DEFAULT_VERIFICATION_ATTEMPTS } from './constants.js';
import type { LastFailedFeedback, AcceptanceFailedNotification } from './types.js';
import {
  emitContractNotifyFailed,
  emitContractSubtaskResetToTodo,
  emitContractVerificationResetFailed,
  emitSubtaskForceAccepted,
} from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

type NotifyType = 'subtask_completed' | 'verification_failed' | 'contract_completed' | 'contract_cancelled';

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

  ctx.notifyClaw(ctx.clawId, {
    type: verdict === 'passed' ? 'verification_result' : 'verification_rejection',
    source: 'contract_system',
    to: ctx.clawId,
    priority: verdict === 'rejected' ? 'high' : 'normal',
    body,
    extraFields,
  });
}

/**
 * phase 1405: force-accept path inbox notification
 *
 * Called when retry_count >= verification_attempts and verification still fails.
 * System decides to force-accept the last submission (DP「motion 是决策主体」—
 * system retry threshold doesn't substitute for motion's quality judgment;
 * motion sees force_accepted flag + last_failed_feedback in contract_completed
 * and decides whether to create a new contract).
 *
 * Claw needs this inbox or it'll wait forever after submit_subtask in async mode.
 */
export function writeForceAcceptInbox(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  allCompleted: boolean,
  retryCount: number,
  lastFeedback: string | undefined,
): void {
  const summary = lastFeedback ? `\n⚠ last_failure: ${lastFeedback}` : '';
  const body = allCompleted
    ? `Subtask ${subtaskId} force-accepted after ${retryCount} attempts. All subtasks complete!${summary}`
    : `Subtask ${subtaskId} force-accepted after ${retryCount} attempts.${summary}`;

  ctx.notifyClaw(ctx.clawId, {
    type: 'verification_result',
    source: 'contract_system',
    to: ctx.clawId,
    priority: 'normal',
    body,
    extraFields: {
      contract_id: contractId,
      subtask_id: subtaskId,
      verdict: 'passed',
      force_accepted: 'true',
      retry_count: String(retryCount),
    },
  });
}

/**
 * phase 19 Step C: pure inbox notification, no progress mutation (SRP).
 * Caller of writeVerificationError used to bundle this with retry handling;
 * now decomposed so each function has single responsibility.
 */
export function notifyVerificationError(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  errorMsg: string,
): void {
  ctx.notifyClaw(ctx.clawId, {
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
  });
}

/**
 * phase 19 Step C: pure retry state machine (SRP).
 * progress lock + retry_count increment + force-accept decision + inbox/safeNotify.
 * Returns { archived } so caller (runVerificationInBackground catch) can do archiveAndEmit
 * outside the progress lock.
 */
async function isContractActive(ctx: VerificationContext, contractId: ContractId): Promise<boolean> {
  try {
    const container = await ctx.contractDir(contractId);
    return path.normalize(container) === path.normalize(activeContainerDir());
  } catch {
    return false;
  }
}

export async function handleVerificationErrorRetry(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  cause: LastFailedFeedback['cause'],
  feedbackText: string,
): Promise<{ archived?: boolean }> {
  let result: { archived?: boolean } = {};
  try {
    await ctx.withProgressLock(contractId, async () => {
      // Phase 1132 Step D: lifecycle guard based on active path.
      if (!(await isContractActive(ctx, contractId))) {
        emitContractVerificationResetFailed(
          ctx.audit,
          {
            contractId,
            subtaskId,
            context: 'handleVerificationErrorRetry',
            message: 'contract no longer active, skip error retry reset',
          },
        );
        return;
      }
      const progress = await ctx.getProgress(contractId);
      if (!progress) {
        throw new ToolError(`Contract "${contractId}" unloadable: progress schema corruption`);
      }
      const subtask = progress.subtasks[subtaskId];
      if (subtask && subtask.status === 'in_progress') {
        subtask.status = 'todo';
        subtask.retry_count = (subtask.retry_count || 0) + 1;
        subtask.last_failed_feedback = { feedback: feedbackText, cause };

        const contractYaml = await ctx.loadContractYaml(contractId);
        if (!contractYaml) {
          throw new ToolError(`Contract "${contractId}" unloadable: contract.yaml schema corruption`);
        }
        const maxAttempts = contractYaml.verification_attempts ?? DEFAULT_VERIFICATION_ATTEMPTS;

        if (subtask.retry_count >= maxAttempts) {
          // 强制接受：timeout/crash 路径达上限同样 force_accepted
          subtask.status = 'completed';
          subtask.completed_at = new Date().toISOString();
          subtask.force_accepted = true;
          const lastFeedback = subtask.last_failed_feedback?.feedback;
          await ctx.saveProgress(contractId, progress);
          emitSubtaskForceAccepted(ctx.audit, {
            contractId, subtaskId, retryCount: subtask.retry_count, claw: ctx.clawId,
          });
          safeNotify(ctx, 'subtask_completed', {
            contract_id: contractId, subtask_id: subtaskId, force_accepted: true,
          });

          const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
          // phase 1405: force-accept 必给 claw inbox 反馈、否则 submit_subtask async claw 永远等不到 verdict
          writeForceAcceptInbox(ctx, contractId, subtaskId, allCompleted, subtask.retry_count, lastFeedback);
          if (allCompleted) {
            progress.completed_at = new Date().toISOString();
            await ctx.saveProgress(contractId, progress);
            // archiveAndEmit 由 caller（runVerificationInBackground catch）在 withProgressLock 外调用
            result = { archived: false };
            return;
          }
          return;
        }
        await ctx.saveProgress(contractId, progress);
        // phase 425: retry path saveProgress 完成 audit、tests 用此 event 等 state settle
        emitContractSubtaskResetToTodo(ctx.audit, {
          contractId, subtaskId, cause, retryCount: subtask.retry_count, maxAttempts,
        });
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
    // phase 521 (review-round4 Core M1): reset 失败时尝试 fallback 单独 lock 重置 in_progress→todo
    // 防 subtask 永卡 in_progress、后续 submit_subtask call 全报 "already in_progress"。
    // 若 fallback 也失败 → emit STUCK_IN_PROGRESS observability、需运维手动修
    try {
      await ctx.withProgressLock(contractId, async () => {
        const fbProgress = await ctx.getProgress(contractId);
        const fbSubtask = fbProgress?.subtasks[subtaskId];
        if (fbSubtask && fbSubtask.status === 'in_progress') {
          // Phase 969 / 1132 Step D: lifecycle guard based on active path, not persisted status.
          if (!(await isContractActive(ctx, contractId))) {
            return;
          }
          fbSubtask.status = 'todo';
          delete fbSubtask.verification_attempt_id;
          await ctx.saveProgress(contractId, fbProgress!);
        }
      });
    } catch (fbErr) {
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.VERIFICATION_STUCK_IN_PROGRESS,
        `contract_id=${contractId}`,
        `subtask_id=${subtaskId}`,
        `cause=${cause}`,
        `outer_error=${formatErr(e)}`,
        `fallback_error=${formatErr(fbErr)}`,
      );
    }
  }
  return result;
}

/**
 * Orchestrator: classify error → notify inbox → run retry state machine.
 * Kept under existing name for backward compat with single callsite in verification.ts.
 */
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

  notifyVerificationError(ctx, contractId, subtaskId, errorMsg);
  return handleVerificationErrorRetry(ctx, contractId, subtaskId, cause, feedbackText);
}

