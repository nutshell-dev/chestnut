/**
 * @module L4.ContractSystem.Verification.Notify
 * Notify helpers — safe wrapper + inbox writer + error disposition handling
 *
 * phase 1829：通知与状态处置一致——
 * - 每条新生成通知携带 contract/subtask/attempt 身份与已提交处置；
 * - handleVerificationErrorRetry 返回真实 disposition（ErrorHandlingResult），
 *   不再用 `{}` 混合不同出口，也不在内部写 force-accept inbox；
 * - writeVerificationError 依据 disposition 发一条完整通知；通知投递失败只记
 *   audit，不回灌为新的验收失败。
 */

import type {
  ErrorDisposition,
  ErrorHandlingResult,
  VerificationContext,
  VerificationFailureContext,
  VerificationNoticeIdentity,
} from './verification-types.js';
import type { ContractId } from './types.js';
import type { SubtaskId } from './types.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import {
  verificationCrashedFeedback,
  verificationErrorForceAcceptedNotice,
  verificationErrorNotAppliedNotice,
  verificationErrorReturnedNotice,
  verificationErrorUnconfirmedNotice,
  verificationForceAcceptedNotice,
  verificationPassedNotice,
  verificationRejectedNotice,
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

/**
 * phase 1829 Z 补修：提交后副作用失败的兜底记录。audit 自身也可能失败——此时降级
 * stderr，绝不把副作用异常继续抛回业务错误恢复链。
 * detail.context 存在时走 VERIFICATION_RESET_FAILED（操作性故障），否则走
 * NOTIFY_FAILED（通知/投递失败）。
 */
export function recordVerificationSideEffectFailure(
  ctx: VerificationContext,
  detail: { notifyType?: string; context?: string; error: string },
): void {
  try {
    if (detail.context !== undefined) {
      emitContractVerificationResetFailed(ctx.audit, { context: detail.context, error: detail.error });
    } else {
      emitContractNotifyFailed(ctx.audit, { notifyType: detail.notifyType, error: detail.error });
    }
  } catch (auditErr) {
    process.stderr.write(`[verification] side-effect failure audit error: ${formatErr(auditErr)}\n`);
  }
}

export function safeNotify(
  ctx: VerificationContext,
  event: ContractNotification,
): void {
  try {
    ctx.onNotify?.(event);
  } catch (err) {
    // phase 1829 Z 补修：失败审计自身失败时降级 stderr，safeNotify 不向外抛
    recordVerificationSideEffectFailure(
      ctx,
      { notifyType: event.type, error: formatErr(err) },
    );
  }
}

function identityExtraFields(identity: VerificationNoticeIdentity): Record<string, string> {
  const fields: Record<string, string> = {
    contract_id: identity.contractId,
    subtask_id: identity.subtaskId,
  };
  if (identity.attemptId !== undefined) fields.attempt_id = identity.attemptId;
  if (identity.observedAt !== undefined) fields.observed_at = identity.observedAt;
  return fields;
}

export function writeVerificationInbox(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  verdict: 'passed' | 'rejected',
  allCompleted: boolean | 'unknown',
  feedback?: string,
  retryCount?: number,
  notice?: { attemptId?: string; observedAt?: string },
): void {
  const identity: VerificationNoticeIdentity = { contractId, subtaskId, ...notice };
  const extraFields: Record<string, string> = {
    ...identityExtraFields(identity),
    verdict,
  };
  if (retryCount !== undefined) extraFields.retry_count = String(retryCount);

  const body = verdict === 'passed'
    ? verificationPassedNotice({ ...identity, allCompleted })
    : verificationRejectedNotice({ ...identity, feedback });

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
 *
 * phase 1829: 正文明确「按阈值记为完成」而非验收通过，并携带身份与已提交次数。
 */
export function writeForceAcceptInbox(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  allCompleted: boolean | 'unknown',
  retryCount: number,
  lastFeedback: string | undefined,
  notice?: { attemptId?: string; observedAt?: string; maxAttempts?: number },
): void {
  const identity: VerificationNoticeIdentity = { contractId, subtaskId, ...notice };
  const body = verificationForceAcceptedNotice({
    ...identity,
    retryCount,
    maxAttempts: notice?.maxAttempts ?? retryCount,
    allCompleted,
    feedback: lastFeedback,
  });

  ctx.notifyClaw(ctx.clawId, {
    type: 'verification_result',
    source: 'contract_system',
    to: ctx.clawId,
    priority: 'normal',
    body,
    extraFields: {
      ...identityExtraFields(identity),
      verdict: 'passed',
      force_accepted: 'true',
      retry_count: String(retryCount),
    },
  });
}

async function isContractActive(ctx: VerificationContext, contractId: ContractId): Promise<boolean> {
  return ctx.isActiveContract(contractId);
}

function notApplied(
  reason: 'not_active' | 'not_in_progress' | 'missing_subtask' | 'late' | 'conflict' | 'skipped',
  extra: { actualAttemptId?: string; detail?: string; observedStatus?: string } = {},
  processingErrors: readonly string[] = [],
): ErrorHandlingResult {
  return { disposition: { kind: 'not_applied', reason, ...extra }, processingErrors };
}

/**
 * phase 521 (review-round4 Core M1): reset 失败时尝试 fallback 重置 in_progress→todo
 * 防 subtask 永卡 in_progress、后续 submit_subtask call 全报 "already in_progress"。
 * 若 fallback 也失败 → emit STUCK_IN_PROGRESS observability、需运维手动修
 * Phase 1201 Step B: fallback 改 typed interrupt transition（queued + attempt guard），
 * 不再 raw saveProgress。
 * phase 1829: fallback 只作用于处理开始绑定的原 attempt；fresh-read 发现不同
 * attempt 时退出并记录 late，禁止用新 attempt ID 替换原身份。
 */
async function fallbackInterrupt(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  cause: LastFailedFeedback['cause'],
  boundAttemptId: string | undefined,
  originalErr: unknown,
): Promise<ErrorHandlingResult> {
  const originalError = formatErr(originalErr);
  try {
    const fbProgress = await ctx.getProgress(contractId);
    const fbSubtask = fbProgress?.subtasks[subtaskId];
    if (!fbSubtask) {
      return notApplied('missing_subtask', {}, [originalError]);
    }
    if (fbSubtask.status !== 'in_progress') {
      return notApplied('not_in_progress', { observedStatus: String(fbSubtask.status) }, [originalError]);
    }
    if (!fbSubtask.verification_attempt_id) {
      return notApplied('skipped', { detail: 'subtask in_progress without verification_attempt_id' }, [originalError]);
    }
    // 兼容未传 attempt 的入口在最初有效读取时绑定一次，之后规则相同。
    const effectiveAttemptId = boundAttemptId ?? fbSubtask.verification_attempt_id;
    if (fbSubtask.verification_attempt_id !== effectiveAttemptId) {
      return notApplied('late', { actualAttemptId: fbSubtask.verification_attempt_id }, [originalError]);
    }
    // Phase 969 / 1132 Step D: lifecycle guard based on active path, not persisted status.
    if (!(await isContractActive(ctx, contractId))) {
      return notApplied('not_active', {}, [originalError]);
    }
    const fbResult = await ctx.transitionVerificationAttempt(
      contractId,
      subtaskId,
      {
        kind: 'interrupt',
        attemptId: effectiveAttemptId,
        at: new Date().toISOString(),
      },
    );
    if (fbResult.kind === 'updated') {
      const retryCount = fbResult.progress.subtasks[subtaskId]?.retry_count ?? 0;
      return {
        disposition: { kind: 'interrupted_to_todo', attemptId: effectiveAttemptId, retryCount },
        processingErrors: [originalError],
      };
    }
    if (fbResult.kind === 'late') {
      return notApplied(
        'late',
        fbResult.actualAttemptId !== undefined ? { actualAttemptId: fbResult.actualAttemptId } : {},
        [originalError],
      );
    }
    return notApplied('skipped', { detail: fbResult.reason }, [originalError]);
  } catch (fbErr) {
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.VERIFICATION_STUCK_IN_PROGRESS,
      `contract_id=${contractId}`,
      `subtask_id=${subtaskId}`,
      `cause=${cause}`,
      `outer_error=${originalError}`,
      `fallback_error=${formatErr(fbErr)}`,
    );
    return {
      disposition: { kind: 'unconfirmed', processingError: formatErr(fbErr) },
      processingErrors: [originalError, formatErr(fbErr)],
    };
  }
}

/**
 * phase 19 Step C: pure retry state machine (SRP).
 * verification transition + force-accept decision + audit/safeNotify。
 * phase 1829: 返回真实 disposition；提交后副作用（audit/onNotify/完成度读取）失败
 * 追加到 processingErrors，不把已提交处置改写成「处理未发生」；inbox 通知由
 * writeVerificationError 依据 disposition 统一发出。
 * Returns { archived } projection so caller (runVerificationInBackground catch) can do
 * archiveAndEmit outside the verification mutex.
 */
export async function handleVerificationErrorRetry(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  cause: LastFailedFeedback['cause'],
  feedbackText: string,
  attemptId?: string,
  errorFact?: SerializableErrorFact,
): Promise<ErrorHandlingResult> {
  // phase 1829: attempt 绑定在处理开始确定，之后（含 fallback）不再更换。
  let boundAttemptId: string | undefined = attemptId;
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
      return notApplied('not_active');
    }
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      throw new ToolError(`Contract "${contractId}" unloadable: progress schema corruption`);
    }
    const subtask = progress.subtasks[subtaskId];
    if (!subtask) {
      return notApplied('missing_subtask');
    }
    if (subtask.status !== 'in_progress') {
      return notApplied('not_in_progress', { observedStatus: String(subtask.status) });
    }

    const contractYaml = await ctx.loadContractYaml(contractId);
    if (!contractYaml) {
      throw new ToolError(`Contract "${contractId}" unloadable: contract.yaml schema corruption`);
    }
    const maxAttempts = contractYaml.verification_attempts ?? DEFAULT_VERIFICATION_ATTEMPTS;
    // Phase 1201 Step B: attemptId 优先由 caller（background pipeline 已知自己的
    // attempt）传入；缺失时退回 fresh-read 当前 attempt。forceAccept 由 queued
    // mutation 基于 fresh retry_count 计算。
    const effectiveAttemptId = boundAttemptId ?? subtask.verification_attempt_id!;
    boundAttemptId = effectiveAttemptId;

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
          return notApplied('conflict');
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

    if (transitionResult.kind === 'late') {
      emitContractVerificationResetFailed(
        ctx.audit,
        {
          contractId,
          subtaskId,
          context: 'handleVerificationErrorRetry',
          message: 'attempt id mismatch',
        },
      );
      return notApplied(
        'late',
        transitionResult.actualAttemptId !== undefined
          ? { actualAttemptId: transitionResult.actualAttemptId }
          : {},
      );
    }
    if (transitionResult.kind !== 'updated') {
      emitContractVerificationResetFailed(
        ctx.audit,
        {
          contractId,
          subtaskId,
          context: 'handleVerificationErrorRetry',
          message: transitionResult.reason,
        },
      );
      return notApplied('skipped', { detail: transitionResult.reason });
    }

    // phase 1829: 已提交——立即固定 disposition，再执行 audit/onNotify 副作用；
    // 副作用失败追加 processingErrors，不改写已提交处置、不进入 fallback。
    const updatedProgress = transitionResult.progress;
    const updatedSubtask = updatedProgress.subtasks[subtaskId];
    const retryCount = updatedSubtask?.retry_count ?? 1;
    const forceAccept = updatedSubtask?.force_accepted === true;
    const processingErrors: string[] = [];

    if (forceAccept) {
      const lastFeedback = updatedSubtask?.last_failed_feedback?.feedback;
      // phase 1829 Z4 补修：完成度是独立事实，单独先行固定；读取失败显式记
      // 'unknown'（audit + processingErrors），不以默认 false 冒充未完成，也
      // 不被后续 audit/onNotify 副作用异常改写。
      let allCompleted: boolean | 'unknown' = 'unknown';
      try {
        allCompleted = await ctx.checkAllSubtasksCompleted(contractId, updatedProgress);
      } catch (completionErr) {
        processingErrors.push(formatErr(completionErr));
        recordVerificationSideEffectFailure(ctx, {
          context: 'handleVerificationErrorRetry.checkAllSubtasksCompleted',
          error: formatErr(completionErr),
        });
      }
      let archived: boolean | undefined;
      if (allCompleted === true) {
        // archiveAndEmit 由 caller（runVerificationInBackground catch）调用
        archived = false;
      }
      try {
        emitSubtaskForceAccepted(ctx.audit, {
          contractId, subtaskId, retryCount, claw: ctx.clawId,
        });
      } catch (sideErr) {
        processingErrors.push(formatErr(sideErr));
      }
      safeNotify(ctx, {
        type: 'subtask_completed',
        contractId,
        subtaskId,
        forceAccepted: true,
      } satisfies ContractNotification);
      return {
        disposition: {
          kind: 'force_accepted',
          attemptId: effectiveAttemptId,
          retryCount,
          maxAttempts,
          allCompleted,
          ...(lastFeedback !== undefined ? { feedback: lastFeedback } : {}),
        },
        processingErrors,
        ...(archived !== undefined ? { archived } : {}),
      };
    }

    // retry_count < maxAttempts: 保留 retry 路径（audit 与 onNotify 各自隔离）
    try {
      // phase 425: retry path transition 完成 audit、tests 用此 event 等 state settle
      emitContractSubtaskResetToTodo(ctx.audit, {
        contractId, subtaskId, cause, retryCount, maxAttempts,
      });
    } catch (sideErr) {
      processingErrors.push(formatErr(sideErr));
    }
    safeNotify(ctx, {
      type: 'verification_failed',
      contractId,
      subtaskId,
      cause,
      feedback: feedbackText,
      retryCount,
      maxAttempts,
    } satisfies ContractNotification);
    return {
      disposition: { kind: 'returned_to_todo', attemptId: effectiveAttemptId, retryCount },
      processingErrors,
    };
  } catch (e) {
    emitContractVerificationResetFailed(
      ctx.audit,
      { context: 'ContractSystem._writeVerificationError.resetStatus', error: formatErr(e) },
    );
    return fallbackInterrupt(ctx, contractId, subtaskId, cause, boundAttemptId, e);
  }
}

/**
 * phase 1829: 依据已确认 disposition 发一条完整通知。
 * 错误后放行选 verification_result（含原异常与放行事实），其余选 verification_error。
 */
function writeVerificationDispositionInbox(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  errorMsg: string,
  result: ErrorHandlingResult,
  attemptId: string | undefined,
  failure: VerificationFailureContext | undefined,
): void {
  const d: ErrorDisposition = result.disposition;
  const identity: VerificationNoticeIdentity = {
    contractId,
    subtaskId,
    attemptId: ('attemptId' in d && d.attemptId !== undefined) ? d.attemptId : attemptId,
  };
  // phase 1829 Z2 补修：processingErrors 是公共事实，所有 disposition 分支都传递；
  // 模板以明细列表呈现，不用分号拼接掩盖不同错误归属。
  const processingErrors = result.processingErrors;

  if (d.kind === 'force_accepted') {
    ctx.notifyClaw(ctx.clawId, {
      type: 'verification_result',
      source: 'contract_system',
      to: ctx.clawId,
      priority: 'normal',
      body: verificationErrorForceAcceptedNotice({
        ...identity,
        errorMessage: errorMsg,
        retryCount: d.retryCount,
        maxAttempts: d.maxAttempts,
        allCompleted: d.allCompleted,
        // phase 1829 Z5 补修：已知验收结论必须进入放行通知；not_passed 时优先呈现
        // verifier 已给出的反馈（committed last_failed_feedback 是异常处置文本）。
        knownVerdict: failure?.knownVerdict,
        processingErrors,
        feedback: failure?.knownVerdict === 'not_passed'
          ? (failure.feedback ?? d.feedback)
          : d.feedback,
      }),
      extraFields: {
        ...identityExtraFields(identity),
        verdict: 'passed',
        force_accepted: 'true',
        retry_count: String(d.retryCount),
      },
    });
    return;
  }

  let body: string;
  switch (d.kind) {
    case 'returned_to_todo':
    case 'interrupted_to_todo':
      body = verificationErrorReturnedNotice({
        ...identity,
        errorMessage: errorMsg,
        stage: failure?.stage ?? 'unspecified',
        knownVerdict: failure?.knownVerdict,
        retryCount: d.retryCount,
        processingErrors,
      });
      break;
    case 'not_applied':
      body = verificationErrorNotAppliedNotice({
        ...identity,
        errorMessage: errorMsg,
        reason: d.reason,
        detail: d.detail,
        observedStatus: d.observedStatus,
        actualAttemptId: d.actualAttemptId,
        knownVerdict: failure?.knownVerdict,
        processingErrors,
      });
      break;
    case 'unconfirmed':
      body = verificationErrorUnconfirmedNotice({
        ...identity,
        errorMessage: errorMsg,
        // 完整处理异常明细；为空时至少保留 disposition 自身的处置失败事实
        processingErrors: processingErrors.length > 0 ? processingErrors : [d.processingError],
        knownVerdict: failure?.knownVerdict,
      });
      break;
  }

  ctx.notifyClaw(ctx.clawId, {
    type: 'verification_error',
    source: 'contract_system',
    to: ctx.clawId,
    priority: 'high',
    body,
    idPrefix: 'verification_error',
    extraFields: identityExtraFields(identity),
  });
}

/**
 * Orchestrator: classify error → run retry state machine → 按 disposition 发一次通知。
 * Kept under existing name for backward compat with single callsite in verification.ts.
 * phase 1829: 通知投递与状态处置隔离——投递失败只记 audit，不进入状态回退/计数。
 */
export async function writeVerificationError(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  error: unknown,
  attemptId?: string,
  failure?: VerificationFailureContext,
): Promise<{ archived?: boolean }> {
  const errorMsg = formatErr(error);
  const cause: LastFailedFeedback['cause'] =
    error instanceof ToolTimeoutError ? 'subagent_timeout' : 'programming_bug';
  const feedbackText =
    cause === 'subagent_timeout'
      ? verificationTimeoutFeedback(String((error as ToolTimeoutError).context?.timeoutMs ?? '?'), errorMsg)
      : verificationCrashedFeedback(errorMsg);

  // Phase 1201 Step C: error fact 传入 retry state machine，由其 durable-first persist。
  const errorFact: SerializableErrorFact = {
    message: errorMsg,
    name: error instanceof Error ? error.constructor.name : typeof error,
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };

  let result: ErrorHandlingResult;
  try {
    result = await handleVerificationErrorRetry(ctx, contractId, subtaskId, cause, feedbackText, attemptId, errorFact);
  } catch (handlingErr) {
    // 处置链路自身逃出（handleVerificationErrorRetry 已内含 fallback，正常不可达）
    result = {
      disposition: { kind: 'unconfirmed', processingError: formatErr(handlingErr) },
      processingErrors: [formatErr(handlingErr)],
    };
  }

  try {
    writeVerificationDispositionInbox(ctx, contractId, subtaskId, errorMsg, result, attemptId, failure);
  } catch (notifyErr) {
    // 投递失败只记 audit；audit 自身失败降级 stderr，不再向外抛（phase 1829 Z3）
    recordVerificationSideEffectFailure(
      ctx,
      { notifyType: 'verification_error', error: formatErr(notifyErr) },
    );
  }

  return result.archived !== undefined ? { archived: result.archived } : {};
}
