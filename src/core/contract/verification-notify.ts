/**
 * @module L4.ContractSystem.Verification.Notify
 * Notify helpers — safe wrapper + inbox writer + error writer
 */

import type { VerificationContext } from './verification-types.js';
import type { ContractId } from './types.js';
import type { SubtaskId } from './types.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import {
  forceAcceptMessage,
  subtaskAcceptedMessage,
  verificationCrashedFeedback,
  verificationErrorMessage,
  verificationRejectionMessage,
  verificationTimeoutFeedback,
} from '../../templates/messages/index.js';
import { ToolError, ToolTimeoutError } from '../../foundation/tools/index.js';
import { DEFAULT_VERIFICATION_ATTEMPTS } from './constants.js';
import type { ContractNotification } from './notification.js';
import type { LastFailedFeedback } from './types.js';
import {
  emitContractNotifyFailed,
  emitContractSubtaskResetToTodo,
  emitContractVerificationResetFailed,
  emitSubtaskForceAccepted,
} from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import {
  buildVerificationOutcome,
  type SerializableErrorFact,
} from './verification-outcome.js';

export function safeNotify(
  ctx: VerificationContext,
  event: ContractNotification,
): void {
  try {
    ctx.onNotify?.(event);
  } catch (err) {
    emitContractNotifyFailed(
      ctx.audit,
      { notifyType: event.type, error: formatErr(err) },
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
    body = subtaskAcceptedMessage(subtaskId, allCompleted);
  } else {
    body = verificationRejectionMessage(feedback);
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
  const body = forceAcceptMessage({ subtaskId, retryCount, allCompleted, lastFeedback });

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
function notifyVerificationError(
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
    body: verificationErrorMessage(errorMsg),
    idPrefix: 'verification_error',
    extraFields: {
      contract_id: contractId,
      subtask_id: subtaskId,
    },
  });
}

/**
 * phase 19 Step C: pure retry state machine (SRP).
 * verification mutex + retry_count increment + force-accept decision + inbox/safeNotify.
 * Returns { archived } so caller (runVerificationInBackground catch) can do archiveAndEmit
 * outside the verification mutex.
 */
async function isContractActive(ctx: VerificationContext, contractId: ContractId): Promise<boolean> {
  return ctx.isActiveContract(contractId);
}

export async function handleVerificationErrorRetry(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  cause: LastFailedFeedback['cause'],
  feedbackText: string,
  attemptId?: string,
  errorFact?: SerializableErrorFact,
): Promise<{ archived?: boolean }> {
  let result: { archived?: boolean } = {};
  try {
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
      return result;
    }
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      throw new ToolError(`Contract "${contractId}" unloadable: progress schema corruption`);
    }
    const subtask = progress.subtasks[subtaskId];
    if (!subtask || subtask.status !== 'in_progress') {
      return result;
    }

    const contractYaml = await ctx.loadContractYaml(contractId);
    if (!contractYaml) {
      throw new ToolError(`Contract "${contractId}" unloadable: contract.yaml schema corruption`);
    }
    const maxAttempts = contractYaml.verification_attempts ?? DEFAULT_VERIFICATION_ATTEMPTS;
    // Phase 1201 Step B: attemptId 优先由 caller（background pipeline 已知自己的
    // attempt）传入；缺失时退回 fresh-read 当前 attempt。forceAccept 由 queued
    // mutation 基于 fresh retry_count 计算。
    const effectiveAttemptId = attemptId ?? subtask.verification_attempt_id!;

    // Phase 1201 Step C: errored outcome 先持久化 immutable fact，再 queued reject。
    if (errorFact !== undefined) {
      const persistResult = await ctx.persistVerificationOutcome(buildVerificationOutcome(
        { contractId, subtaskId, attemptId: effectiveAttemptId, completedAt: new Date().toISOString() },
        { kind: 'errored', error: errorFact, cause, feedback: feedbackText, maxAttempts },
      ));
      // Phase 1201 Step E: conflict fail-closed —— durable fact 与本次 payload 冲突时
      // 不得 transition/side effect（audit 已含 immutable conflict fact）。
      switch (persistResult) {
        case 'persisted':
        case 'idempotent':
          break;
        case 'conflict':
          return result;
      }
    }

    const transitionResult = await ctx.transitionVerificationAttempt(
      contractId,
      subtaskId,
      {
        kind: 'reject',
        attemptId: effectiveAttemptId,
        at: new Date().toISOString(),
        feedback: feedbackText,
        cause,
        maxAttempts,
      },
    );

    if (transitionResult.kind !== 'updated') {
      emitContractVerificationResetFailed(
        ctx.audit,
        {
          contractId,
          subtaskId,
          context: 'handleVerificationErrorRetry',
          message: transitionResult.kind === 'skipped' ? transitionResult.reason : 'attempt id mismatch',
        },
      );
      return result;
    }

    const updatedProgress = transitionResult.progress;
    const updatedSubtask = updatedProgress.subtasks[subtaskId];
    const retryCount = updatedSubtask?.retry_count ?? 1;
    const forceAccept = updatedSubtask?.force_accepted === true;

    if (forceAccept) {
      const lastFeedback = updatedSubtask?.last_failed_feedback?.feedback;
      emitSubtaskForceAccepted(ctx.audit, {
        contractId, subtaskId, retryCount, claw: ctx.clawId,
      });
      safeNotify(ctx, {
        type: 'subtask_completed',
        contractId,
        subtaskId,
        forceAccepted: true,
      } satisfies ContractNotification);

      const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, updatedProgress);
      // phase 1405: force-accept 必给 claw inbox 反馈、否则 submit_subtask async claw 永远等不到 verdict
      writeForceAcceptInbox(ctx, contractId, subtaskId, allCompleted, retryCount, lastFeedback);
      if (allCompleted) {
        // archiveAndEmit 由 caller（runVerificationInBackground catch）调用
        result = { archived: false };
      }
      return result;
    }

    // retry_count < maxAttempts: 保留 retry 路径
    // phase 425: retry path transition 完成 audit、tests 用此 event 等 state settle
    emitContractSubtaskResetToTodo(ctx.audit, {
      contractId, subtaskId, cause, retryCount, maxAttempts,
    });
    safeNotify(ctx, {
      type: 'verification_failed',
      contractId,
      subtaskId,
      cause,
      feedback: feedbackText,
      retryCount,
      maxAttempts,
    } satisfies ContractNotification);
  } catch (e) {
    emitContractVerificationResetFailed(
      ctx.audit,
      { context: 'ContractSystem._writeVerificationError.resetStatus', error: formatErr(e) },
    );
    // phase 521 (review-round4 Core M1): reset 失败时尝试 fallback 重置 in_progress→todo
    // 防 subtask 永卡 in_progress、后续 submit_subtask call 全报 "already in_progress"。
    // 若 fallback 也失败 → emit STUCK_IN_PROGRESS observability、需运维手动修
    // Phase 1201 Step B: fallback 改 typed interrupt transition（queued + attempt guard），
    // 不再 raw saveProgress。
    try {
      const fbProgress = await ctx.getProgress(contractId);
      const fbSubtask = fbProgress?.subtasks[subtaskId];
      if (fbSubtask && fbSubtask.status === 'in_progress' && fbSubtask.verification_attempt_id) {
        // Phase 969 / 1132 Step D: lifecycle guard based on active path, not persisted status.
        if (await isContractActive(ctx, contractId)) {
          await ctx.transitionVerificationAttempt(
            contractId,
            subtaskId,
            {
              kind: 'interrupt',
              attemptId: fbSubtask.verification_attempt_id,
              at: new Date().toISOString(),
            },
          );
        }
      }
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
  attemptId?: string,
): Promise<{ archived?: boolean }> {
  const errorMsg = formatErr(error);
  const cause: LastFailedFeedback['cause'] =
    error instanceof ToolTimeoutError ? 'subagent_timeout' : 'programming_bug';
  const feedbackText =
    cause === 'subagent_timeout'
      ? verificationTimeoutFeedback(String((error as ToolTimeoutError).context?.timeoutMs ?? '?'), errorMsg)
      : verificationCrashedFeedback(errorMsg);

  notifyVerificationError(ctx, contractId, subtaskId, errorMsg);
  // Phase 1201 Step C: error fact 传入 retry state machine，由其 durable-first persist。
  const errorFact: SerializableErrorFact = {
    message: errorMsg,
    name: error instanceof Error ? error.constructor.name : typeof error,
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
  return handleVerificationErrorRetry(ctx, contractId, subtaskId, cause, feedbackText, attemptId, errorFact);
}

