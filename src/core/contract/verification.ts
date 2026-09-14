/**
 * @module L4.ContractSystem.Verification
 * Verification pipeline — thin orchestration layer over 4 sub-file clusters
 * (phase 1237: functional module sub-file split / DAG / 0 public API change)
 */

import * as path from 'path';
import type { ContractYaml, VerificationResult, SubtaskId } from './types.js';
import type { ContractNotification } from './notification.js';
import { ToolError } from '../../foundation/tools/index.js';
import { formatErr, newUuid } from '../../foundation/node-utils/index.js';
import { DEFAULT_VERIFICATION_ATTEMPTS } from './constants.js';
import {
  emitContractCompleteOnCancelled,
  emitContractNotifyFailed,
  emitContractPassed,
  emitContractProgressCorrupted,
  emitContractSubtaskCompleted,
  emitContractUnexpectedAsyncThrow,
  emitContractVerificationBackgroundDone,
  emitContractVerificationBackgroundFailed,
  emitContractSubtaskResetToTodo,
  emitContractVerificationFailed,
  emitContractVerificationResetFailed,
  emitContractVerificationStarted,
  emitSubtaskForceAccepted,
  emitVerificationOutcomeLate,
} from './audit-emit.js';
import { buildVerificationOutcome } from './verification-outcome.js';


import { archiveAndEmit, completeSubtaskSync } from './verification-lifecycle.js';
import { writeVerificationInbox, writeForceAcceptInbox, writeVerificationError, safeNotify } from './verification-notify.js';
import { formatRejectionFeedback } from './verification-format.js';
import type { VerificationContext, VerificationFailureContext } from './verification-types.js';
import type { ContractId } from './types.js';
import {
  verificationConfigMissingPromptFileFeedback,
  verificationConfigMissingScriptFileFeedback,
} from '../../templates/messages/index.js';


export type { VerificationContext } from './verification-types.js';

type VerificationConfig =
  | { subtask_id: string; type: 'script'; script_file?: string }
  | { subtask_id: string; type: 'llm'; prompt_file?: string };

/**
 * phase 19 Step B: dispatch via handler registry (OCP).
 * New verification type = new entry in VERIFICATION_HANDLERS, no source-code branch change.
 */
type VerificationHandlerArgs = {
  contractAbsDir: string;
  contractId: ContractId;
  subtaskId: SubtaskId;
  subtaskDesc: string;
  evidence: string;
  artifacts: string[];
};

type VerificationHandler<T extends VerificationConfig['type']> = (
  ctx: VerificationContext,
  cfg: Extract<VerificationConfig, { type: T }>,
  args: VerificationHandlerArgs,
) => Promise<VerificationResult>;

const VERIFICATION_HANDLERS: { [T in VerificationConfig['type']]: VerificationHandler<T> } = {
  script: async (ctx, cfg, args) => {
    if (!cfg.script_file) {
      emitContractVerificationResetFailed(ctx.audit, {
        context: 'ContractSystem.runVerificationByType',
        message: 'verification config missing script_file',
      });
      return { passed: false, feedback: verificationConfigMissingScriptFileFeedback() };
    }
    return ctx.runScriptVerification(cfg.script_file, args.contractAbsDir);
  },
  llm: async (ctx, cfg, args) => {
    if (!cfg.prompt_file) {
      emitContractVerificationResetFailed(ctx.audit, {
        context: 'ContractSystem.runVerificationByType',
        message: 'verification config missing prompt_file',
      });
      return { passed: false, feedback: verificationConfigMissingPromptFileFeedback() };
    }
    return ctx.runLLMVerification(
      cfg.prompt_file,
      args.contractAbsDir,
      args.contractId,
      args.subtaskId,
      args.subtaskDesc,
      args.evidence,
      args.artifacts,
    );
  },
};

async function runVerificationByType(
  ctx: VerificationContext,
  verificationConfig: VerificationConfig,
  contractAbsDir: string,
  contractId: ContractId,
  subtaskId: SubtaskId,
  subtaskDesc: string,
  evidence: string,
  artifacts: string[],
): Promise<VerificationResult> {
  const handler = VERIFICATION_HANDLERS[verificationConfig.type] as VerificationHandler<typeof verificationConfig.type>;
  return handler(ctx, verificationConfig as Extract<VerificationConfig, { type: typeof verificationConfig.type }>, {
    contractAbsDir, contractId, subtaskId, subtaskDesc, evidence, artifacts,
  });
}

type ApplyOutcome =
  | { allCompleted: boolean; passed: boolean }
  | { kind: 'cancelled' }
  | { kind: 'missing_subtask' }
  | { kind: 'skipped' }
  | { kind: 'late' };

async function isContractActive(ctx: VerificationContext, contractId: ContractId): Promise<boolean> {
  return ctx.isActiveContract(contractId);
}

async function applyVerificationOutcome(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  subtaskDesc: string,
  result: VerificationResult,
  contractYaml: ContractYaml,
  verificationConfig: VerificationConfig,
  attemptId: string,
  at: string,
): Promise<ApplyOutcome> {
  // Phase 1136 Step C: lifecycle guard based on physical active path.
  if (!(await isContractActive(ctx, contractId))) {
    emitContractVerificationResetFailed(
      ctx.audit,
      {
        contractId,
        subtaskId,
        context: 'applyVerificationOutcome',
        message: 'contract no longer active, skip verification outcome write',
      },
    );
    return { kind: 'skipped' };
  }

  const progress = await ctx.getProgress(contractId);
  if (!progress) {
    throw new ToolError(`Contract "${contractId}" progress unavailable: schema corruption`);
  }

  const subtask = progress.subtasks[subtaskId];
  if (!subtask) {
    emitContractProgressCorrupted(
      ctx.audit,
      {
        context: 'ContractSystem.applyVerificationOutcome',
        contractId,
        subtaskId,
        error: 'subtask missing from progress after in_progress mark',
      },
    );
    return { kind: 'missing_subtask' };
  }

  if (result.passed) {
    const transitionResult = await ctx.transitionVerificationAttempt(
      contractId,
      subtaskId,
      { kind: 'pass', attemptId, at },
    );
    if (transitionResult.kind === 'late') {
      // Phase 1201 Step C: 旧 attempt outcome 晚到新 attempt —— durable fact 已
      // 保留，progress 不被覆盖，audit superseded。
      emitVerificationOutcomeLate(ctx.audit, {
        contractId,
        subtaskId,
        attemptId,
        outcomeKind: 'passed',
        ...(transitionResult.actualAttemptId !== undefined
          ? { actualAttemptId: transitionResult.actualAttemptId }
          : {}),
      });
      return { kind: 'late' };
    }
    if (transitionResult.kind !== 'updated') {
      return { kind: 'skipped' };
    }
    const updatedProgress = transitionResult.progress;
    // phase 1829: 已提交 pass——通知/audit/完成度读取等后续副作用与提交隔离；
    // 失败只记 audit，不得再次 reject/计数/fallback。
    let allCompleted = false;
    try {
      allCompleted = await ctx.checkAllSubtasksCompleted(contractId, updatedProgress);
      safeNotify(ctx, {
        type: 'subtask_completed',
        contractId,
        subtaskId,
      } satisfies ContractNotification);
      const subtaskTotal = contractYaml.subtasks.length;
      const completedCount = Object.values(updatedProgress.subtasks).filter(s => s.status === 'completed').length;

      // Phase 968: emit completion audit AFTER transition commits
      emitContractSubtaskCompleted(
        ctx.audit,
        {
          contractId,
          subtaskId,
          progress: `${completedCount}/${subtaskTotal}`,
          claw: ctx.clawId,
        },
      );
      emitContractPassed(ctx.audit, { contractId, subtaskId });
      writeVerificationInbox(ctx, contractId, subtaskId, 'passed', allCompleted, undefined, undefined, { attemptId, observedAt: at });
    } catch (postCommitErr) {
      emitContractNotifyFailed(
        ctx.audit,
        { notifyType: 'verification_result', error: formatErr(postCommitErr) },
      );
    }

    return { allCompleted, passed: true };
  }

  const failureCause = verificationConfig.type === 'script' ? 'script_failed' : 'llm_rejected';
  const maxAttempts = contractYaml.verification_attempts ?? DEFAULT_VERIFICATION_ATTEMPTS;

  // Phase 1201 Step B: forceAccept 不再由 queue 外预读快照计算；transition 携带
  // maxAttempts，queued mutation 基于 fresh retry_count 决定，本函数按 commit 后
  // 的 updated progress 分支。
  const transitionResult = await ctx.transitionVerificationAttempt(
    contractId,
    subtaskId,
    {
      kind: 'reject',
      attemptId,
      at,
      feedback: result.feedback,
      cause: failureCause,
      maxAttempts,
    },
  );
  if (transitionResult.kind === 'late') {
    emitVerificationOutcomeLate(ctx.audit, {
      contractId,
      subtaskId,
      attemptId,
      outcomeKind: 'rejected',
      ...(transitionResult.actualAttemptId !== undefined
        ? { actualAttemptId: transitionResult.actualAttemptId }
        : {}),
    });
    return { kind: 'late' };
  }
  if (transitionResult.kind !== 'updated') {
    return { kind: 'skipped' };
  }

  // phase 1829: 已提交 reject——先固定已提交事实，后续 audit/notify/inbox 副作用
  // 与提交隔离；副作用失败只记 audit，不二次 reject/计数。
  const updatedProgress = transitionResult.progress;
  const updatedSubtask = updatedProgress.subtasks[subtaskId];
  const retryCount = updatedSubtask?.retry_count ?? 1;
  const forceAccept = updatedSubtask?.force_accepted === true;
  try {
    // Phase 1142: verification_failed Audit must only be written after the reject transition commits.
    emitContractVerificationFailed(
      ctx.audit,
      // phase 217: 末端单次 .message 截、producer (verifier-job) 已不自截
      { contractId, subtaskId, feedback: ctx.audit.message(result.feedback) },
    );

    const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, updatedProgress);

    if (forceAccept) {
      const lastFeedback = updatedSubtask?.last_failed_feedback?.feedback;
      safeNotify(ctx, {
        type: 'subtask_completed',
        contractId,
        subtaskId,
        forceAccepted: true,
      } satisfies ContractNotification);

      // Phase 968: emit force-accept audit AFTER transition commits
      emitSubtaskForceAccepted(ctx.audit, {
        contractId, subtaskId, retryCount, claw: ctx.clawId,
      });

      // phase 1405: force-accept 必给 claw inbox 反馈、否则 submit_subtask async claw 永远等不到 verdict
      writeForceAcceptInbox(ctx, contractId, subtaskId, allCompleted, retryCount, lastFeedback, { attemptId, observedAt: at, maxAttempts });

      // archiveAndEmit 由 runVerificationInBackground 调用（避免在 outcome 提交内嵌套生命周期操作）
      return { allCompleted, passed: true };
    }

    // retry_count < maxAttempts: 保留 retry 路径
    safeNotify(ctx, {
      type: 'verification_failed',
      contractId,
      subtaskId,
      cause: failureCause,
      feedback: result.feedback,
      retryCount,
      maxAttempts,
    } satisfies ContractNotification);
    // phase 425: retry path transition 完成 audit、tests 用此 event 等 state settle
    emitContractSubtaskResetToTodo(ctx.audit, {
      contractId, subtaskId, cause: failureCause, retryCount, maxAttempts,
    });

    const verificationFile = verificationConfig.type === 'script'
      ? verificationConfig.script_file ?? 'unknown'
      : verificationConfig.prompt_file ?? 'unknown';
    const formattedFeedback = result.structured
      ? formatRejectionFeedback(
          subtaskId,
          subtaskDesc,
          result.structured.reason,
          result.structured.issues || [],
          retryCount,
          maxAttempts,
          verificationConfig.type,
          verificationFile,
        )
      : result.feedback;
    writeVerificationInbox(ctx, contractId, subtaskId, 'rejected', false, formattedFeedback, retryCount, { attemptId, observedAt: at });

    return { allCompleted: false, passed: false };
  } catch (postCommitErr) {
    emitContractNotifyFailed(
      ctx.audit,
      { notifyType: forceAccept ? 'verification_result' : 'verification_rejection', error: formatErr(postCommitErr) },
    );
    return forceAccept ? { allCompleted: false, passed: true } : { allCompleted: false, passed: false };
  }
}

export async function runVerificationPipeline(
  ctx: VerificationContext,
  params: { contractId: ContractId; subtaskId: SubtaskId; evidence: string; artifacts?: string[] },
): Promise<VerificationResult> {
  const { contractId, subtaskId, evidence, artifacts } = params;

  const contractYaml = await ctx.loadContractYaml(contractId);
  if (!contractYaml) {
    throw new ToolError(`Contract "${contractId}" unloadable: contract.yaml schema corruption`);
  }

  // Phase 1132 Step D: lifecycle guard based on physical active path, not persisted status.
  if (!(await ctx.isActiveContract(contractId))) {
    emitContractVerificationResetFailed(
      ctx.audit,
      {
        contractId,
        subtaskId,
        context: 'runVerificationPipeline',
        message: 'contract is not active, verification cannot start',
      },
    );
    return {
      passed: false,
      feedback: `Contract "${contractId}" is not active, cannot start verification for subtask "${subtaskId}".`,
      allCompleted: false,
    };
  }

  const verificationConfig = contractYaml.verification?.find(a => a.subtask_id === subtaskId);

  // Phase 1201 Step D: 内存闸门已删除。duplicate async submit 完全由 queued
  // fresh-read start transition 的 status/attempt 规则决定（第二提交见
  // status=in_progress → skipped → ToolError）。
  if (!verificationConfig) {
    return await completeSubtaskSync(ctx, contractId, subtaskId, evidence, artifacts);
  }

  const attemptId = newUuid();
  const startedAt = new Date().toISOString();

  // Phase 1136 Step C: start is expressed as a typed attempt transition.
  // The gateway enforces subtask membership and status guards.
  const startResult = await ctx.transitionVerificationAttempt(
    contractId,
    subtaskId,
    {
      kind: 'start',
      attemptId,
      evidence,
      artifacts: artifacts ?? [],
      at: startedAt,
    },
  );
  if (startResult.kind !== 'updated') {
    emitContractVerificationResetFailed(
      ctx.audit,
      {
        contractId,
        subtaskId,
        context: 'runVerificationPipeline',
        message: startResult.kind === 'skipped' ? startResult.reason : 'start transition skipped',
      },
    );
    throw new ToolError(
      startResult.kind === 'skipped'
        ? `Cannot start verification for subtask "${subtaskId}": ${startResult.reason}`
        : `Cannot start verification for subtask "${subtaskId}": attempt id mismatch`,
    );
  }
  emitContractVerificationStarted(ctx.audit, { contractId, subtaskId });

  // Phase 1201 Step D: background work 的并发安全由 durable outcome persist +
  // attempt guard + per-contract queue 保证，无需进程内闸门。
  runVerificationInBackground(ctx, { ...params, attemptId }, contractYaml, verificationConfig)
    .catch(async (err) => {
      // Phase 965: abort is handled inside runVerificationInBackground and re-thrown so it does not
      // consume a retry. Swallow it here to avoid unhandled rejection; non-abort errors are handled inside.
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      // Fallback for unexpected errors that escaped runVerificationInBackground.
      process.stderr.write(`[verification] unexpected background error: ${formatErr(err)}\n`);
    });

  return { passed: false, feedback: '', async: true };
}

export async function runVerificationInBackground(
  ctx: VerificationContext,
  params: { contractId: ContractId; subtaskId: SubtaskId; evidence: string; artifacts?: string[]; attemptId: string },
  contractYaml: ContractYaml,
  verificationConfig: VerificationConfig,
): Promise<void> {
  const { contractId, subtaskId, evidence, artifacts = [], attemptId } = params;

  const controller = new AbortController();
  let outcomeKind: 'passed' | 'failed' | 'error' | 'cancelled' | 'missing_subtask' | 'skipped' | 'late' = 'error';
  let cancelReason: string | undefined;
  let missingSubtaskId: string | undefined;

  // Phase 967: register controller BEFORE starting the promise so registration
  // failures do not leak a running verification. We use a deferred promise so
  // registerController receives a real Promise immediately. Registration errors
  // are intentionally thrown outside the main try block so they reject the
  // background call instead of being swallowed as a verification error.
  let resolveVerification!: (value: VerificationResult) => void;
  let rejectVerification!: (reason: unknown) => void;
  const promise = new Promise<VerificationResult>((resolve, reject) => {
    resolveVerification = resolve;
    rejectVerification = reject;
  });
  ctx.registerController?.(contractId, controller, promise);

  const isAbort = (err: unknown): boolean =>
    controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');

  // phase 1829: 统一异常处置入口。仅「未提交」阶段的异常进入错误 disposition 链；
  // 携带阶段与已知 verifier 结论，持久化/提交失败不覆盖已取得的验收结论。
  const handleFailure = async (err: unknown, failure: VerificationFailureContext): Promise<void> => {
    // Phase 961: audit failure must not block recovery. The subtask must always be reset from in_progress.
    try {
      if ([TypeError, ReferenceError, SyntaxError, RangeError].some(T => err instanceof T)) {
        emitContractUnexpectedAsyncThrow(
          ctx.audit,
          {
            context: 'ContractSystem.backgroundVerification',
            contractId,
            subtaskId,
            errorType: err instanceof Error ? err.constructor.name : typeof err,
            error: formatErr(err),
            stack: err instanceof Error ? err.stack ?? '' : '',
          },
        );
      } else {
        emitContractVerificationBackgroundFailed(
          ctx.audit,
          { contractId, subtaskId, error: formatErr(err) },
        );
      }
    } catch (auditErr) {
      process.stderr.write(`[verification] background failed audit error: ${formatErr(auditErr)}\n`);
    }
    try {
      const result = await writeVerificationError(ctx, contractId, subtaskId, err, attemptId, failure);
      // phase 1399: writeVerificationError 内防嵌套锁未调 archiveAndEmit，此处补调
      if (result.archived === false) {
        const progressAfterLock = await ctx.getProgress(contractId);
        if (progressAfterLock && (await isContractActive(ctx, contractId))) {
          await archiveAndEmit(ctx, contractId, contractYaml, 'ContractSystem.backgroundVerification.errorForceAccept');
        }
      }
    } catch (inboxErr) {
      emitContractVerificationResetFailed(
        ctx.audit,
        {
          context: 'ContractSystem.backgroundVerification.writeError',
          error: formatErr(inboxErr),
        },
      );
    }
    resolveVerification({ passed: false, feedback: '' });
  };

  try {
    // Close the transition→background window: terminal lifecycle may commit
    // after the start transition but before this background turn begins.
    if (!(await ctx.isActiveContract(contractId))) {
      outcomeKind = 'cancelled';
      cancelReason = 'contract_not_active_before_verifier_start';
      resolveVerification({ passed: false, feedback: '' });
      return;
    }
    const subtaskDef = contractYaml.subtasks.find(st => st.id === subtaskId);
    const subtaskDesc = subtaskDef?.description || subtaskId;
    const contractAbsDir = path.join(ctx.clawDir, await ctx.getContractRoot(contractId));

    // ── 执行阶段（phase 1829: 阶段隔离，捕获异常不等于 verifier 本身失败） ──
    let result: VerificationResult;
    try {
      const ctxWithSignal = { ...ctx, signal: controller.signal };
      runVerificationByType(
        ctxWithSignal,
        verificationConfig,
        contractAbsDir,
        contractId,
        subtaskId,
        subtaskDesc,
        evidence,
        artifacts,
      ).then(resolveVerification, rejectVerification);

      result = await promise;
    } catch (err) {
      if (isAbort(err)) throw err;
      await handleFailure(err, { stage: 'execution', knownVerdict: 'unavailable' });
      return;
    }

    // ── 结果持久化/提交阶段：已获得 verifier 结果，后续失败不声称 verifier 没有结论 ──
    const knownVerdict: VerificationFailureContext['knownVerdict'] = result.passed ? 'passed' : 'not_passed';
    let outcome: ApplyOutcome;
    try {
      // Phase 1201 Step C: durable-first —— verifier 计算结果先持久化为 immutable
      // outcome，再 queued apply；persist→apply 窗口崩溃由 boot replay 恢复（DP1/DP4）。
      const outcomeCompletedAt = new Date().toISOString();
      const resultFact = {
        passed: result.passed,
        feedback: result.feedback,
        ...(result.structured ? { structured: result.structured } : {}),
      };
      const maxAttempts = contractYaml.verification_attempts ?? DEFAULT_VERIFICATION_ATTEMPTS;
      const persistResult = await ctx.persistVerificationOutcome(buildVerificationOutcome(
        { contractId, subtaskId, attemptId, completedAt: outcomeCompletedAt },
        result.passed
          ? { kind: 'passed', result: resultFact }
          : {
              kind: 'rejected',
              result: resultFact,
              cause: verificationConfig.type === 'script' ? 'script_failed' : 'llm_rejected',
              maxAttempts,
            },
      ));
      // Phase 1201 Step E: conflict fail-closed —— durable fact 冲突时不得 apply
      // （不 transition、不 archive、不 retry side effect）。以 error 分类 settle
      // background promise 并直接 return：不进 catch（避免被当成新 errored outcome
      // 形成冲突循环）；audit 已含 immutable conflict fact。
      switch (persistResult) {
        case 'persisted':
        case 'idempotent':
          break;
        case 'conflict': {
          outcomeKind = 'error';
          resolveVerification({ passed: false, feedback: '' });
          return;
        }
      }

      outcome = await applyVerificationOutcome(
        ctx,
        contractId,
        subtaskId,
        subtaskDesc,
        result,
        contractYaml,
        verificationConfig,
        attemptId,
        outcomeCompletedAt,
      );
    } catch (err) {
      if (isAbort(err)) throw err;
      await handleFailure(err, { stage: 'outcome_processing', knownVerdict, feedback: result.feedback });
      return;
    }

    if ('kind' in outcome) {
      if (outcome.kind === 'cancelled') {
        outcomeKind = 'cancelled';
        cancelReason = 'contract_cancelled';
      } else if (outcome.kind === 'missing_subtask') {
        outcomeKind = 'missing_subtask';
        missingSubtaskId = subtaskId;
      } else if (outcome.kind === 'skipped') {
        outcomeKind = 'skipped';
      } else if (outcome.kind === 'late') {
        outcomeKind = 'late';
      }
    } else {
      outcomeKind = outcome.passed ? 'passed' : 'failed';
    }

    if (!('kind' in outcome) && outcome.passed && outcome.allCompleted) {
      // Phase 1132 Step D: archiveAndEmit is the lifecycle commit point. If the contract was
      // cancelled while verification ran, the active path is gone and archiveAndEmit must not run.
      if (!(await isContractActive(ctx, contractId))) {
        emitContractCompleteOnCancelled(
          ctx.audit,
          { contractId, subtaskId, context: 'runVerificationInBackground' },
        );
        outcomeKind = 'cancelled';
        cancelReason = 'contract_cancelled_after_verification';
      } else {
        // phase 1829: 提交后阶段——pass 已提交，归档失败只记 audit，
        // 不得再次 reject/计数/写冲突 outcome。
        try {
          await archiveAndEmit(ctx, contractId, contractYaml, 'ContractSystem._runVerificationInBackground');
        } catch (archiveErr) {
          emitContractVerificationResetFailed(
            ctx.audit,
            {
              context: 'ContractSystem.backgroundVerification.archive',
              error: formatErr(archiveErr),
            },
          );
        }
      }
    }
  } catch (err) {
    // Phase 965: abort is not a verification failure — don't consume retry or write inbox.
    if (isAbort(err)) {
      rejectVerification(err);
      // Phase 1136 Step D: persist abort as an interrupted attempt when the contract is still active.
      try {
        if (await isContractActive(ctx, contractId)) {
          // Phase 1201 Step C: interrupted 也先落 durable outcome 再 queued transition。
          const persistResult = await ctx.persistVerificationOutcome(buildVerificationOutcome(
            { contractId, subtaskId, attemptId, completedAt: new Date().toISOString() },
            {
              kind: 'interrupted',
              reason: controller.signal.aborted ? formatErr(controller.signal.reason) : 'AbortError',
            },
          ));
          // Phase 1201 Step E: conflict fail-closed —— 不做 interrupt transition。
          switch (persistResult) {
            case 'persisted':
            case 'idempotent':
              await ctx.transitionVerificationAttempt(
                contractId,
                subtaskId,
                {
                  kind: 'interrupt',
                  attemptId,
                  at: new Date().toISOString(),
                },
              );
              break;
            case 'conflict':
              break;
          }
        }
      } catch (cleanupErr) {
        // best-effort: audit but don't block
        process.stderr.write(`[verification] abort cleanup failed for ${contractId}/${subtaskId}: ${formatErr(cleanupErr)}\n`);
      }
      throw err;
    }
    // 意外逸出（正常路径已按阶段在 inner catch 处理）：按未知阶段进入错误处置链。
    await handleFailure(err, { stage: 'unspecified', knownVerdict: 'unavailable' });
  } finally {
    ctx.unregisterController?.(contractId, controller);
    try {
      emitContractVerificationBackgroundDone(
        ctx.audit,
        { contractId, subtaskId, result: outcomeKind, cancelReason, missingSubtaskId },
      );
    } catch (auditErr) {
      // Audit failure must not reverse committed business outcome
      process.stderr.write(`[verification] background done audit failed: ${formatErr(auditErr)}\n`);
    }
  }
}

// re-export for backward compat (caller cascade: 2 test files via verification.js barrel — verification.test.ts + state-machine-integrity.test.ts)
export { runScriptVerification, runLLMVerification } from './verification-execution.js';
export { archiveAndEmit, completeSubtaskSync } from './verification-lifecycle.js';
export { writeVerificationInbox, writeForceAcceptInbox, writeVerificationError, safeNotify } from './verification-notify.js';
export { formatRejectionFeedback } from './verification-format.js';
