/**
 * @module L4.ContractSystem.Verification
 * Verification pipeline — thin orchestration layer over 4 sub-file clusters
 * (phase 1237: functional module sub-file split / DAG / 0 public API change)
 */

import * as path from 'path';
import type { AcceptanceFailedNotification, ContractYaml, VerificationResult, SubtaskId } from './types.js';
import { activeContainerDir } from './locations.js';
import { ToolError } from '../../foundation/tools/errors.js';
import { formatErr, newUuid } from '../../foundation/node-utils/index.js';
import { DEFAULT_VERIFICATION_ATTEMPTS } from './constants.js';
import {
  emitContractCompleteOnCancelled,
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
  emitContractVerificationPipelineRaceRejected,
  emitSubtaskForceAccepted,
} from './audit-emit.js';


import { archiveAndEmit, completeSubtaskSync } from './verification-lifecycle.js';
// phase 1465: verification mutex 改 ContractSystem 实例、经 ctx.verificationMutex 访问 (M#3 + Tier 1 真治)
import { writeVerificationInbox, writeForceAcceptInbox, writeVerificationError, safeNotify } from './verification-notify.js';
import { formatRejectionFeedback, formatValidIds } from './verification-format.js';
import type { VerificationContext } from './verification-types.js';
import type { ContractId } from './types.js';


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
      return { passed: false, feedback: 'verification config script 类型缺少 script_file' };
    }
    return ctx.runScriptVerification(cfg.script_file, args.contractAbsDir);
  },
  llm: async (ctx, cfg, args) => {
    if (!cfg.prompt_file) {
      emitContractVerificationResetFailed(ctx.audit, {
        context: 'ContractSystem.runVerificationByType',
        message: 'verification config missing prompt_file',
      });
      return { passed: false, feedback: 'verification config llm 类型缺少 prompt_file' };
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
  | { kind: 'skipped' };

async function isContractActive(ctx: VerificationContext, contractId: ContractId): Promise<boolean> {
  try {
    const container = await ctx.contractDir(contractId);
    return path.normalize(container) === path.normalize(activeContainerDir());
  } catch {
    return false;
  }
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
): Promise<ApplyOutcome> {
  return ctx.withProgressLock(contractId, async () => {
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      // Phase 1132 Step D: contract may have been moved out of active (cancelled/completed/corrupted)
      // between background start and outcome apply. Fail-closed only when still active.
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

    if (subtask.status !== 'in_progress') {
      emitContractVerificationResetFailed(
        ctx.audit,
        {
          contractId,
          subtaskId,
          context: 'applyVerificationOutcome',
          message: `subtask status is "${subtask.status}", expected "in_progress"`,
        },
      );
      return { kind: 'skipped' };
    }

    // Phase 961 / 966: ABA guard — reject result from a previous/missing verification attempt.
    if (subtask.verification_attempt_id !== attemptId) {
      emitContractVerificationResetFailed(
        ctx.audit,
        {
          contractId,
          subtaskId,
          context: 'attempt_id_mismatch',
          message: `expected ${attemptId}, got ${subtask.verification_attempt_id}`,
        },
      );
      return { kind: 'skipped' };
    }

    if (result.passed) {
      subtask.status = 'completed';
      subtask.completed_at = new Date().toISOString();
      safeNotify(ctx, 'subtask_completed', { contractId, subtaskId });
      const subtaskTotal = contractYaml.subtasks.length;
      const completedCount = Object.values(progress.subtasks).filter(s => s.status === 'completed').length;

      const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
      if (allCompleted) {
        progress.completed_at = new Date().toISOString();
      }
      await ctx.saveProgress(contractId, progress);
      // Phase 968: emit completion audit AFTER saveProgress commits
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
      writeVerificationInbox(ctx, contractId, subtaskId, 'passed', allCompleted);

      return { allCompleted, passed: true };
    }

    subtask.retry_count = (subtask.retry_count || 0) + 1;
    const failureCause = verificationConfig.type === 'script' ? 'script_failed' : 'llm_rejected';
    subtask.last_failed_feedback = {
      feedback: result.feedback,
      cause: failureCause,
    };
    const maxAttempts = contractYaml.verification_attempts ?? DEFAULT_VERIFICATION_ATTEMPTS;

    emitContractVerificationFailed(
      ctx.audit,
      // phase 217: 末端单次 .message 截、producer (verifier-job) 已不自截
      { contractId, subtaskId, feedback: ctx.audit.message(result.feedback) },
    );

    if (subtask.retry_count >= maxAttempts) {
      // 强制接受：试光次数当 completed 推进、保留 last_failed_feedback + force_accepted 标记
      subtask.status = 'completed';
      subtask.completed_at = new Date().toISOString();
      subtask.force_accepted = true;
      const lastFeedback = subtask.last_failed_feedback?.feedback;
      safeNotify(ctx, 'subtask_completed', {
        contract_id: contractId, subtask_id: subtaskId, force_accepted: true,
      });

      const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
      if (allCompleted) {
        progress.completed_at = new Date().toISOString();
      }
      await ctx.saveProgress(contractId, progress);
      // Phase 968: emit force-accept audit AFTER saveProgress commits
      emitSubtaskForceAccepted(ctx.audit, {
        contractId, subtaskId, retryCount: subtask.retry_count, claw: ctx.clawId,
      });

      // phase 1405: force-accept 必给 claw inbox 反馈、否则 submit_subtask async claw 永远等不到 verdict
      writeForceAcceptInbox(ctx, contractId, subtaskId, allCompleted, subtask.retry_count, lastFeedback);

      // archiveAndEmit 由 runVerificationInBackground 在 withProgressLock 外调用（防嵌套锁）
      return { allCompleted, passed: true };
    }

    // retry_count < maxAttempts: 保留 retry 路径
    subtask.status = 'todo';
    safeNotify(ctx, 'verification_failed', {
      contract_id: contractId,
      subtask_id: subtaskId,
      cause: failureCause,
      feedback: result.feedback,
      retry_count: subtask.retry_count,
      max_attempts: maxAttempts,
    } satisfies AcceptanceFailedNotification);
    await ctx.saveProgress(contractId, progress);
    // phase 425: retry path saveProgress 完成 audit、tests 用此 event 等 state settle
    emitContractSubtaskResetToTodo(ctx.audit, {
      contractId, subtaskId, cause: failureCause, retryCount: subtask.retry_count, maxAttempts,
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
          subtask.retry_count,
          maxAttempts,
          verificationConfig.type,
          verificationFile,
        )
      : result.feedback;
    writeVerificationInbox(ctx, contractId, subtaskId, 'rejected', false, formattedFeedback, subtask.retry_count);

    return { allCompleted: false, passed: false };
  });
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
  if (!(await isContractActive(ctx, contractId))) {
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

  // phase 438: sync 路径（无 verificationConfig）保持原有"幂等守卫"语义 —
  // 第二个并发提交进 completeSubtaskSync 通过内层 progressLock 串行、
  // 见 status='completed' 结构化返回 "already completed"（不 race-reject）；
  // 与 async 路径"必须 race-reject 防 bg 串扰"是两种并发模型、不统一闸门。
  // review R2-C-N13 指控复核站不住、本 phase 不改 sync 语义。
  if (verificationConfig) {
    if (!ctx.verificationMutex.acquire(contractId, subtaskId)) {
      emitContractVerificationPipelineRaceRejected(
        ctx.audit,
        { contractId, subtaskId, context: 'runVerificationPipeline', reason: 'verification_pipeline_already_active' },
      );
      throw new ToolError(`Verification pipeline for contract "${contractId}" subtask "${subtaskId}" is already active — concurrent attempt rejected.`);
    }
  }

  // handedOff = true 表示 release 所有权已交给 bg promise 的 .finally；
  // 此函数返回前不可再 release。phase 438: 配对结构对称化（review N3-C-H2）。
  // 仅 verificationConfig 存在时 acquire、!verificationConfig 时无需 release。
  let handedOff = false;
  try {
    if (!verificationConfig) {
      return await completeSubtaskSync(ctx, contractId, subtaskId, evidence, artifacts);
    }

  const attemptId = newUuid();
  let lifecycleRejected: string | null = null;

  await ctx.withProgressLock(contractId, async () => {
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      throw new ToolError(`Contract "${contractId}" progress unavailable: schema corruption`);
    }
    // Phase 968 / 1132 Step D: lifecycle guard based on subtask state + attempt id.
    // Physical active-path guard already ran before acquiring the lock; subtask-level
    // guards remain to reject duplicate or stale submissions.
    if (!progress.subtasks[subtaskId]) {
      throw new ToolError(`Unknown subtask "${subtaskId}". Valid subtask IDs: ${formatValidIds(progress)}`);
    }
    const currentStatus = progress.subtasks[subtaskId].status;
    if (currentStatus === 'in_progress') {
      throw new ToolError(`Subtask "${subtaskId}" verification is already in progress — duplicate submit_subtask call ignored.`);
    }
    if (currentStatus === 'completed') {
      throw new ToolError(`Subtask "${subtaskId}" is already completed.`);
    }
    progress.subtasks[subtaskId] = {
      ...progress.subtasks[subtaskId],
      status: 'in_progress',
      evidence,
      artifacts,
      verification_attempt_id: attemptId,
    };
    await ctx.saveProgress(contractId, progress);
    emitContractVerificationStarted(ctx.audit, { contractId, subtaskId });
  });

  if (lifecycleRejected) {
    return {
      passed: false,
      feedback: `Contract status is "${lifecycleRejected}", cannot start verification for subtask "${subtaskId}".`,
    };
  }

  // phase 337 M1 / review-2026-06-13: mutex hold must span the background
  // work lifetime, not just the in-progress mark commit. Earlier early-release
  // (削 phase 1371 sub-3 闭环) let a second completeSubtask reach background-
  // work concurrently with the first when status briefly flipped during
  // archiveAndEmit / rollback windows. Release in .finally() of the bg promise.
  runVerificationInBackground(ctx, { ...params, attemptId }, contractYaml, verificationConfig)
    .catch(async (err) => {
      // Phase 965: abort is handled inside runVerificationInBackground and re-thrown so it does not
      // consume a retry. Swallow it here to avoid unhandled rejection; non-abort errors are handled inside.
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      // Fallback for unexpected errors that escaped runVerificationInBackground.
      process.stderr.write(`[verification] unexpected background error: ${formatErr(err)}\n`);
    })
    .finally(() => {
      // phase 337 M1: 释放 mutex 必须在 background work 全 settle 后、
      // 覆盖整个 hold-window。否则第二个 completeSubtask 会在 archiveAndEmit
      // 或 rollback 窗口里 race 进入 background。
      ctx.verificationMutex.release(contractId, subtaskId);
    });
  // phase 438: bg promise 的 .finally 已绑定 release —— 所有权移交给 bg。
  // 不可在 outer finally 再 release（会重复）。
  handedOff = true;

  return { passed: false, feedback: '', async: true };
  } finally {
    if (verificationConfig && !handedOff) {
      // verificationConfig 存在时 acquire 成功（!handedOff 表示 release 未交给 bg）
      // sync 异常路径（withProgressLock throw、saveProgress throw、其他 sync 异常）
      // 必须在此处释放。
      ctx.verificationMutex.release(contractId, subtaskId);
    }
  }
}

export async function runVerificationInBackground(
  ctx: VerificationContext,
  params: { contractId: ContractId; subtaskId: SubtaskId; evidence: string; artifacts?: string[]; attemptId: string },
  contractYaml: ContractYaml,
  verificationConfig: VerificationConfig,
): Promise<void> {
  const { contractId, subtaskId, evidence, artifacts = [], attemptId } = params;

  const controller = new AbortController();
  let outcomeKind: 'passed' | 'failed' | 'error' | 'cancelled' | 'missing_subtask' | 'skipped' = 'error';
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

  try {
    const subtaskDef = contractYaml.subtasks.find(st => st.id === subtaskId);
    const subtaskDesc = subtaskDef?.description || subtaskId;
    const contractAbsDir = path.join(ctx.clawDir, await ctx.contractDir(contractId), contractId);

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

    const result = await promise;

    const outcome = await applyVerificationOutcome(
      ctx,
      contractId,
      subtaskId,
      subtaskDesc,
      result,
      contractYaml,
      verificationConfig,
      attemptId,
    );

    if ('kind' in outcome) {
      if (outcome.kind === 'cancelled') {
        outcomeKind = 'cancelled';
        cancelReason = 'contract_cancelled';
      } else if (outcome.kind === 'missing_subtask') {
        outcomeKind = 'missing_subtask';
        missingSubtaskId = subtaskId;
      } else if (outcome.kind === 'skipped') {
        outcomeKind = 'skipped';
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
        await archiveAndEmit(ctx, contractId, contractYaml, 'ContractSystem._runVerificationInBackground');
      }
    }
  } catch (err) {
    // Phase 965: abort is not a verification failure — don't consume retry or write inbox.
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      rejectVerification(err);
      // Phase 966: reset subtask from in_progress → todo so next submit can retry.
      try {
        await ctx.withProgressLock(contractId, async () => {
          const progress = await ctx.getProgress(contractId);
          // Phase 970 / 1132 Step D: only reset subtasks for active contracts.
          if (progress && (await isContractActive(ctx, contractId))) {
            const subtask = progress.subtasks[subtaskId];
            if (subtask && subtask.status === 'in_progress' &&
                subtask.verification_attempt_id === attemptId) {
              subtask.status = 'todo';
              delete subtask.verification_attempt_id;
              await ctx.saveProgress(contractId, progress);
            }
          }
        });
      } catch (cleanupErr) {
        // best-effort: audit but don't block
        process.stderr.write(`[verification] abort cleanup failed for ${contractId}/${subtaskId}: ${formatErr(cleanupErr)}\n`);
      }
      throw err;
    }
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
    await writeVerificationError(ctx, contractId, subtaskId, err).then(async (result) => {
      // phase 1399: writeVerificationError 内防嵌套锁未调 archiveAndEmit，此处补调
      if (result.archived === false) {
        const progressAfterLock = await ctx.getProgress(contractId);
        if (progressAfterLock && (await isContractActive(ctx, contractId))) {
          await archiveAndEmit(ctx, contractId, contractYaml, 'ContractSystem.backgroundVerification.errorForceAccept');
        }
      }
    }).catch(inboxErr => {
      emitContractVerificationResetFailed(
        ctx.audit,
        {
          context: 'ContractSystem.backgroundVerification.writeError',
          error: formatErr(inboxErr),
        },
      );
    });
    resolveVerification({ passed: false, feedback: '' });
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
