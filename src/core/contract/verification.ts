/**
 * @module L4.ContractSystem.Verification
 * Verification pipeline — thin orchestration layer over 4 sub-file clusters
 * (phase 1237: functional module sub-file split / DAG / 0 public API change)
 */

import * as path from 'path';
import type { AcceptanceFailedNotification, ContractYaml, VerificationResult, SubtaskId } from './types.js';
import { ToolError, isProgrammingBug } from '../../foundation/errors.js';
import { formatErr } from '../../foundation/utils/index.js';
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
  | { kind: 'missing_subtask' };

async function applyVerificationOutcome(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  subtaskDesc: string,
  result: VerificationResult,
  contractYaml: ContractYaml,
  verificationConfig: VerificationConfig,
): Promise<ApplyOutcome> {
  return ctx.withProgressLock(contractId, async () => {
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      throw new ToolError(`Contract "${contractId}" progress unavailable: schema corruption`);
    }

    if (progress.status === 'cancelled') {
      emitContractVerificationResetFailed(
        ctx.audit,
        {
          contractId,
          subtaskId,
          context: 'applyVerificationOutcome',
          message: 'contract already cancelled, skip verification outcome write',
        },
      );
      return { kind: 'cancelled' };
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
      subtask.status = 'completed';
      subtask.completed_at = new Date().toISOString();
      safeNotify(ctx, 'subtask_completed', { contractId, subtaskId });
      const subtaskTotal = contractYaml.subtasks.length;
      const completedCount = Object.values(progress.subtasks).filter(s => s.status === 'completed').length;
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

      const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
      if (allCompleted) {
        progress.status = 'completed';
      }
      await ctx.saveProgress(contractId, progress);
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
      emitSubtaskForceAccepted(ctx.audit, {
        contractId, subtaskId, retryCount: subtask.retry_count, claw: ctx.clawId,
      });
      safeNotify(ctx, 'subtask_completed', {
        contract_id: contractId, subtask_id: subtaskId, force_accepted: true,
      });

      const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
      if (allCompleted) { progress.status = 'completed'; }
      await ctx.saveProgress(contractId, progress);

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

  await ctx.withProgressLock(contractId, async () => {
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      throw new ToolError(`Contract "${contractId}" progress unavailable: schema corruption`);
    }
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
    };
    await ctx.saveProgress(contractId, progress);
    emitContractVerificationStarted(ctx.audit, { contractId, subtaskId });
  });

  // phase 337 M1 / review-2026-06-13: mutex hold must span the background
  // work lifetime, not just the in-progress mark commit. Earlier early-release
  // (削 phase 1371 sub-3 闭环) let a second completeSubtask reach background-
  // work concurrently with the first when status briefly flipped during
  // archiveAndEmit / rollback windows. Release in .finally() of the bg promise.
  runVerificationInBackground(ctx, params, contractYaml, verificationConfig)
    .catch(err => {
      if (isProgrammingBug(err)) {
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
      writeVerificationError(ctx, contractId, subtaskId, err).then(async (result) => {
        // phase 1399: writeVerificationError 内防嵌套锁未调 archiveAndEmit，此处补调
        if (result.archived === false) {
          const progressAfterLock = await ctx.getProgress(contractId);
          if (progressAfterLock && progressAfterLock.status === 'completed') {
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
  params: { contractId: ContractId; subtaskId: SubtaskId; evidence: string; artifacts?: string[] },
  contractYaml: ContractYaml,
  verificationConfig: VerificationConfig,
): Promise<void> {
  const { contractId, subtaskId, evidence, artifacts = [] } = params;
  const subtaskDef = contractYaml.subtasks.find(st => st.id === subtaskId);
  const subtaskDesc = subtaskDef?.description || subtaskId;
  const contractAbsDir = path.join(ctx.clawDir, await ctx.contractDir(contractId), contractId);

  let outcomeKind: 'passed' | 'failed' | 'error' | 'cancelled' | 'missing_subtask' = 'error';
  let cancelReason: string | undefined;
  let missingSubtaskId: string | undefined;
  try {
    const result = await runVerificationByType(
      ctx,
      verificationConfig,
      contractAbsDir,
      contractId,
      subtaskId,
      subtaskDesc,
      evidence,
      artifacts,
    );

    const outcome = await applyVerificationOutcome(
      ctx,
      contractId,
      subtaskId,
      subtaskDesc,
      result,
      contractYaml,
      verificationConfig,
    );

    if ('kind' in outcome) {
      if (outcome.kind === 'cancelled') {
        outcomeKind = 'cancelled';
        cancelReason = 'contract_cancelled';
      } else if (outcome.kind === 'missing_subtask') {
        outcomeKind = 'missing_subtask';
        missingSubtaskId = subtaskId;
      }
    } else {
      outcomeKind = outcome.passed ? 'passed' : 'failed';
    }

    if (!('kind' in outcome) && outcome.passed && outcome.allCompleted) {
      const progressAfterLock = await ctx.getProgress(contractId);
      if (!progressAfterLock) {
        throw new ToolError(`Contract "${contractId}" progress unavailable: schema corruption`);
      }
      if (progressAfterLock.status === 'cancelled') {
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
  } finally {
    emitContractVerificationBackgroundDone(
      ctx.audit,
      { contractId, subtaskId, result: outcomeKind, cancelReason, missingSubtaskId },
    );
  }
}

// re-export for backward compat (caller cascade: 2 test files via verification.js barrel — verification.test.ts + state-machine-integrity.test.ts)
export { runScriptVerification, runLLMVerification } from './verification-execution.js';
export { archiveAndEmit, completeSubtaskSync } from './verification-lifecycle.js';
export { writeVerificationInbox, writeForceAcceptInbox, writeVerificationError, safeNotify } from './verification-notify.js';
export { formatRejectionFeedback } from './verification-format.js';
