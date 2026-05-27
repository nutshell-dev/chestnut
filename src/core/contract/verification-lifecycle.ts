/**
 * @module L4.ContractSystem.Verification.Lifecycle
 * Lifecycle ops — archive + emit + subtask complete
 */

import type { VerificationContext } from './verification-types.js';
import type { VerificationResult, SubtaskId } from './types.js';
import { safeNotify } from './verification-notify.js';
import { formatValidIds } from './verification-format.js';
import { formatErr } from '../../foundation/utils/format.js';
import type { ContractId } from './types.js';
import {
  emitContractCompleted,
  emitContractMoveArchiveFailed,
  emitContractSubtaskCompleted,

  emitContractUpdated,
  emitContractCompleteOnCancelled,
  emitContractVerificationResetFailed,
  emitContractProgressCorrupted,
  emitContractSubtaskDuplicateDone,
  emitContractSubtaskAlreadyCompleted,
} from './audit-emit.js';

export async function archiveAndEmit(
  ctx: VerificationContext,
  contractId: ContractId,
  title: string,
  contextLabel: string,
): Promise<void> {
  try {
    await ctx.moveContractToArchive(contractId);
    emitContractCompleted(
      ctx.audit,
      { contractId, title, claw: ctx.clawId },
    );
    await ctx.emitContractCompleted(contractId);
    safeNotify(ctx, 'contract_completed', { contractId, title });
  } catch (err) {
    try {
      await ctx.withProgressLock(contractId, async () => {
        const progress = await ctx.getProgress(contractId);
        if (progress.status === 'completed') {
          progress.status = 'running';
          await ctx.saveProgress(contractId, progress);
        }
      });
    } catch (revertErr) {
      emitContractMoveArchiveFailed(
        ctx.audit,
        {
          context: `${contextLabel}.revertStatus`,
          message: 'revert progress.status to running failed after archive failed',
          error: formatErr(revertErr),
        },
      );
    }
    emitContractMoveArchiveFailed(
      ctx.audit,
      {
        context: contextLabel,
        message: 'moveToArchive failed; progress.status reverted to running for retry',
        error: formatErr(err),
      },
    );
  }
}

export async function completeSubtaskSync(
  ctx: VerificationContext,
  contractId: ContractId,
  subtaskId: SubtaskId,
  evidence: string,
  artifacts?: string[],
): Promise<VerificationResult> {
  let allCompleted = false;
  let result: VerificationResult = { passed: true, feedback: 'No verification criteria configured' };
  const contractYaml = await ctx.loadContractYaml(contractId);

  await ctx.withProgressLock(contractId, async () => {
    const progress = await ctx.getProgress(contractId);

    if (progress.status === 'cancelled') {
      emitContractVerificationResetFailed(
        ctx.audit,
        {
          contractId,
          subtaskId,
          context: 'completeSubtaskSync',
          message: 'contract already cancelled, skip subtask completion write',
        },
      );
      return;
    }

    if (!progress.subtasks[subtaskId]) {
      result = { passed: false, feedback: `Unknown subtask "${subtaskId}". Valid subtask IDs: ${formatValidIds(progress)}` };
      emitContractProgressCorrupted(
        ctx.audit,
        {
          context: 'ContractSystem._completeSubtaskSync',
          contractId,
          subtaskId,
          message: 'Unknown subtaskId',
        },
      );
      return;
    }

    const currentStatus = progress.subtasks[subtaskId].status;
    if (currentStatus === 'in_progress') {
      result = { passed: false, feedback: `Subtask "${subtaskId}" verification is already in progress — duplicate submit_subtask call ignored.` };
      emitContractSubtaskDuplicateDone(ctx.audit, { contractId, subtaskId });
      return;
    }
    if (currentStatus === 'completed') {
      result = { passed: false, feedback: `Subtask "${subtaskId}" is already completed.` };
      emitContractSubtaskAlreadyCompleted(ctx.audit, { contractId, subtaskId });
      return;
    }

    progress.subtasks[subtaskId] = {
      ...progress.subtasks[subtaskId],
      status: 'completed',
      completed_at: new Date().toISOString(),
      evidence,
      artifacts,
    };
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

    allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
    if (allCompleted) {
      progress.status = 'completed';
    }

    await ctx.saveProgress(contractId, progress);
    emitContractUpdated(
      ctx.audit,
      {
        contractId,
        subtaskId,
        status: allCompleted ? 'completed' : 'running',
      },
    );
  });

  if (allCompleted) {
    const progressAfterLock = await ctx.getProgress(contractId);
    if (progressAfterLock.status === 'cancelled') {
      emitContractCompleteOnCancelled(ctx.audit, { contractId, subtaskId });
      return { ...result, allCompleted: false };
    }
    await archiveAndEmit(ctx, contractId, contractYaml.title, 'ContractSystem._completeSubtaskSync');
  }

  return { ...result, allCompleted };
}
