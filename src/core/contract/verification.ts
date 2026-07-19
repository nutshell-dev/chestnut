/**
 * @module L4.ContractSystem.Verification
 * Verification pipeline — thin orchestration layer over 4 sub-file clusters
 * (phase 1237: functional module sub-file split / DAG / 0 public API change)
 */

import * as path from 'path';
import type { AcceptanceFailedNotification, ContractYaml, VerificationResult, SubtaskId } from './types.js';
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
import { formatRejectionFeedback } from './verification-format.js';
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
): Promise<ApplyOutcome> {
  return ctx.withProgressLock(contractId, async () => {
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

    const at = new Date().toISOString();

    if (result.passed) {
      const transitionResult = await ctx.transitionVerificationAttempt(
        contractId,
        subtaskId,
        { kind: 'pass', attemptId, at },
      );
      if (transitionResult.kind === 'late') {
        return { kind: 'late' };
      }
      if (transitionResult.kind !== 'updated') {
        return { kind: 'skipped' };
      }
      const updatedProgress = transitionResult.progress;
      const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, updatedProgress);
      safeNotify(ctx, 'subtask_completed', { contractId, subtaskId });
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
      writeVerificationInbox(ctx, contractId, subtaskId, 'passed', allCompleted);

      return { allCompleted, passed: true };
    }

    const failureCause = verificationConfig.type === 'script' ? 'script_failed' : 'llm_rejected';
    const maxAttempts = contractYaml.verification_attempts ?? DEFAULT_VERIFICATION_ATTEMPTS;
    const priorRejected = subtask.retry_count ?? 0;
    const forceAccept = priorRejected + 1 >= maxAttempts;

    const transitionResult = await ctx.transitionVerificationAttempt(
      contractId,
      subtaskId,
      {
        kind: 'reject',
        attemptId,
        at,
        feedback: result.feedback,
        cause: failureCause,
        forceAccept,
      },
    );
    if (transitionResult.kind === 'late') {
      return { kind: 'late' };
    }
    if (transitionResult.kind !== 'updated') {
      return { kind: 'skipped' };
    }

    // Phase 1142: verification_failed Audit must only be written after the reject transition commits.
    emitContractVerificationFailed(
      ctx.audit,
      // phase 217: 末端单次 .message 截、producer (verifier-job) 已不自截
      { contractId, subtaskId, feedback: ctx.audit.message(result.feedback) },
    );

    const updatedProgress = transitionResult.progress;
    const updatedSubtask = updatedProgress.subtasks[subtaskId];
    const retryCount = updatedSubtask?.retry_count ?? priorRejected + 1;
    const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, updatedProgress);

    if (forceAccept) {
      const lastFeedback = updatedSubtask?.last_failed_feedback?.feedback;
      safeNotify(ctx, 'subtask_completed', {
        contract_id: contractId, subtask_id: subtaskId, force_accepted: true,
      });

      // Phase 968: emit force-accept audit AFTER transition commits
      emitSubtaskForceAccepted(ctx.audit, {
        contractId, subtaskId, retryCount, claw: ctx.clawId,
      });

      // phase 1405: force-accept 必给 claw inbox 反馈、否则 submit_subtask async claw 永远等不到 verdict
      writeForceAcceptInbox(ctx, contractId, subtaskId, allCompleted, retryCount, lastFeedback);

      // archiveAndEmit 由 runVerificationInBackground 在 withProgressLock 外调用（防嵌套锁）
      return { allCompleted, passed: true };
    }

    // retry_count < maxAttempts: 保留 retry 路径
    safeNotify(ctx, 'verification_failed', {
      contract_id: contractId,
      subtask_id: subtaskId,
      cause: failureCause,
      feedback: result.feedback,
      retry_count: retryCount,
      max_attempts: maxAttempts,
    } satisfies AcceptanceFailedNotification);
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
    writeVerificationInbox(ctx, contractId, subtaskId, 'rejected', false, formattedFeedback, retryCount);

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
  const startedAt = new Date().toISOString();

  await ctx.withProgressLock(contractId, async () => {
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
  });

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

  try {
    const subtaskDef = contractYaml.subtasks.find(st => st.id === subtaskId);
    const subtaskDesc = subtaskDef?.description || subtaskId;
    const contractAbsDir = path.join(ctx.clawDir, await ctx.getContractRoot(contractId));

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
        await archiveAndEmit(ctx, contractId, contractYaml, 'ContractSystem._runVerificationInBackground');
      }
    }
  } catch (err) {
    // Phase 965: abort is not a verification failure — don't consume retry or write inbox.
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      rejectVerification(err);
      // Phase 1136 Step D: persist abort as an interrupted attempt when the contract is still active.
      try {
        if (await isContractActive(ctx, contractId)) {
          await ctx.transitionVerificationAttempt(
            contractId,
            subtaskId,
            {
              kind: 'interrupt',
              attemptId,
              at: new Date().toISOString(),
            },
          );
        }
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
