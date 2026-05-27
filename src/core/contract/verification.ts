/**
 * @module L4.ContractSystem.Verification
 * Verification pipeline — thin orchestration layer over 4 sub-file clusters
 * (phase 1237: functional module sub-file split / DAG / 0 public API change)
 */

import * as path from 'path';
import type { AcceptanceFailedNotification, ContractYaml, VerificationResult, SubtaskId } from './types.js';
import { ToolError, isProgrammingBug } from '../../foundation/errors.js';
import { formatErr } from '../../foundation/utils/format.js';
import {
  emitContractCompleteOnCancelled,
  emitContractEscalated,
  emitContractPassed,
  emitContractProgressCorrupted,
  emitContractSubtaskCompleted,
  emitContractUnexpectedAsyncThrow,
  emitContractVerificationBackgroundDone,
  emitContractVerificationBackgroundFailed,
  emitContractVerificationFailed,
  emitContractVerificationResetFailed,
  emitContractVerificationStarted,
} from './audit-emit.js';


import { archiveAndEmit, completeSubtaskSync } from './verification-lifecycle.js';
import { writeVerificationInbox, writeVerificationError, safeNotify } from './verification-notify.js';
import { formatRejectionFeedback, formatValidIds } from './verification-format.js';
import type { VerificationContext } from './verification-types.js';
import type { ContractId } from './types.js';


export type { VerificationContext } from './verification-types.js';

type VerificationConfig =
  | { subtask_id: string; type: 'script'; script_file?: string }
  | { subtask_id: string; type: 'llm'; prompt_file?: string };

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
  if (verificationConfig.type === 'script') {
    const scriptFile = verificationConfig.script_file;
    if (!scriptFile) {
      emitContractVerificationResetFailed(
        ctx.audit,
        {
          context: 'ContractSystem.runVerificationByType',
          message: 'verification config missing script_file',
        },
      );
      return { passed: false, feedback: 'verification config script 类型缺少 script_file' };
    }
    return ctx.runScriptVerification(scriptFile, contractAbsDir);
  }

  const promptFile = verificationConfig.prompt_file;
  if (!promptFile) {
    emitContractVerificationResetFailed(
      ctx.audit,
      {
        context: 'ContractSystem.runVerificationByType',
        message: 'verification config missing prompt_file',
      },
    );
    return { passed: false, feedback: 'verification config llm 类型缺少 prompt_file' };
  }
  return ctx.runLLMVerification(
    promptFile,
    contractAbsDir,
    contractId,
    subtaskId,
    subtaskDesc,
    evidence,
    artifacts,
  );
}

async function applyVerificationOutcome(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  subtaskDesc: string,
  result: VerificationResult,
  contractYaml: ContractYaml,
  verificationConfig: VerificationConfig,
): Promise<{ allCompleted: boolean; passed: boolean } | null> {
  return ctx.withProgressLock(contractId, async () => {
    const progress = await ctx.getProgress(contractId);

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
      return null;
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
      return null;
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
    subtask.status = 'todo';
    const maxRetries = contractYaml.escalation?.max_retries ?? 3;
    safeNotify(ctx, 'verification_failed', {
      contract_id: contractId,
      subtask_id: subtaskId,
      cause: failureCause,
      feedback: result.feedback,
      retry_count: subtask.retry_count,
      max_retries: maxRetries,
    } satisfies AcceptanceFailedNotification);
    emitContractVerificationFailed(
      ctx.audit,
      { contractId, subtaskId, feedback: result.feedback },
    );
    await ctx.saveProgress(contractId, progress);

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
          maxRetries,
          verificationConfig.type,
          verificationFile,
        )
      : result.feedback;
    writeVerificationInbox(ctx, contractId, subtaskId, 'rejected', false, formattedFeedback, subtask.retry_count);

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
        },
      );
    }
    return { allCompleted: false, passed: false };
  });
}

export async function runVerificationPipeline(
  ctx: VerificationContext,
  params: { contractId: ContractId; subtaskId: SubtaskId; evidence: string; artifacts?: string[] },
): Promise<VerificationResult> {
  const { contractId, subtaskId, evidence, artifacts } = params;
  const contractYaml = await ctx.loadContractYaml(contractId);
  const verificationConfig = contractYaml.verification?.find(a => a.subtask_id === subtaskId);

  if (!verificationConfig) {
    return completeSubtaskSync(ctx, contractId, subtaskId, evidence, artifacts);
  }

  await ctx.withProgressLock(contractId, async () => {
    const progress = await ctx.getProgress(contractId);
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
      writeVerificationError(ctx, contractId, subtaskId, err).catch(inboxErr => {
        emitContractVerificationResetFailed(
          ctx.audit,
          {
            context: 'ContractSystem.backgroundVerification.writeError',
            error: formatErr(inboxErr),
          },
        );
      });
    });

  return { passed: false, feedback: '', async: true };
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

  let outcomeKind: 'passed' | 'failed' | 'error' = 'error';
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
    outcomeKind = outcome?.passed ? 'passed' : 'failed';

    if (outcome?.passed && outcome.allCompleted) {
      const progressAfterLock = await ctx.getProgress(contractId);
      if (progressAfterLock.status === 'cancelled') {
        emitContractCompleteOnCancelled(
          ctx.audit,
          { contractId, subtaskId, context: 'runVerificationInBackground' },
        );
        outcomeKind = 'failed';
      } else {
        await archiveAndEmit(ctx, contractId, contractYaml.title, 'ContractSystem._runVerificationInBackground');
      }
    }
  } finally {
    emitContractVerificationBackgroundDone(
      ctx.audit,
      { contractId, subtaskId, result: outcomeKind },
    );
  }
}

// re-export for backward compat (caller cascade 0)
export { runScriptVerification, runLLMVerification } from './verification-execution.js';
export { archiveAndEmit, completeSubtaskSync } from './verification-lifecycle.js';
export { writeVerificationInbox, writeVerificationError, safeNotify } from './verification-notify.js';
export { formatRejectionFeedback } from './verification-format.js';
