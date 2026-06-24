/**
 * @module L4.ContractSystem.Verification.Lifecycle
 * Lifecycle ops — archive + emit + subtask complete
 */

import type { VerificationContext } from './verification-types.js';
import type { VerificationResult, SubtaskId } from './types.js';
import { safeNotify } from './verification-notify.js';
import { formatValidIds } from './verification-format.js';
import { ToolError } from '../../foundation/errors.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { ContractId, ContractYaml } from './types.js';
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
  emitContractArchivePartialRecoveryFailed,
} from './audit-emit.js';

export async function archiveAndEmit(
  ctx: VerificationContext,
  contractId: ContractId,
  contractYaml: ContractYaml,
  contextLabel: string,
): Promise<void> {
  try {
    await ctx.moveContractToArchive(contractId);
    emitContractCompleted(
      ctx.audit,
      { contractId, title: contractYaml.title, claw: ctx.clawId },
    );
    await ctx.emitContractCompleted(contractId);

    const progress = await ctx.getProgress(contractId);
    const subtasksSummary = progress
      ? Object.entries(progress.subtasks)
          .filter(([, st]) => st.status === 'completed')
          .map(([id, st]) => ({ id, completed_at: st.completed_at ?? '', force_accepted: !!st.force_accepted }))
      : [];
    const completedAt = progress
      ? Object.values(progress.subtasks)
          .reduce((max, s) => {
            if (!s.completed_at) return max;
            return s.completed_at > max ? s.completed_at : max;
          }, '')
      : '';

    safeNotify(ctx, 'contract_completed', {
      contractId,
      title: contractYaml.title,
      goal: contractYaml.goal,
      subtasks: subtasksSummary,
      completed_at: completedAt,
    });
  } catch (err) {
    try {
      await ctx.withProgressLock(contractId, async () => {
        const progress = await ctx.getProgress(contractId);
        if (!progress) {
          throw new ToolError(`Contract "${contractId}" progress unavailable: schema corruption`);
        }
        if (progress.status === 'completed') {
          progress.status = 'running';
          await ctx.saveProgress(contractId, progress);
        }
      });
    } catch (revertErr) {
      // phase 1371 sub-2: rollback failure → explicit partial recovery state machine
      // phase 337 M2 (review-2026-06-13): 不覆盖显式终态 cancelled/crashed。
      // 若另一路径（如 cancelContract / markCrashed）在 archive 失败窗口里把 status
      // 推到 cancelled/crashed，pending_recovery 不该重写显式终点。
      // 'completed' 不在守集——它就是 archive 入口的合法起点（archive 失败 → 应 retry）。
      const TERMINAL = new Set<string>(['cancelled', 'crashed']);
      try {
        let skipped: { reason: string; observedStatus: string } | null = null;
        await ctx.withProgressLock(contractId, async () => {
          const progress = await ctx.getProgress(contractId);
          if (!progress) {
            throw new ToolError(`Contract "${contractId}" progress unavailable: schema corruption`);
          }
          if (TERMINAL.has(progress.status)) {
            skipped = { reason: 'terminal_status', observedStatus: progress.status };
            return;
          }
          progress.status = 'archive_pending_recovery';
          await ctx.saveProgress(contractId, progress);
        });
        if (skipped !== null) {
          const s = skipped as { reason: string; observedStatus: string };
          emitContractArchivePartialRecoveryFailed(
            ctx.audit,
            {
              contractId,
              context: `${contextLabel}.skippedPendingRecovery`,
              message: `archive failed and rollback failed; refused to overwrite ${s.observedStatus} status with archive_pending_recovery`,
              error: formatErr(revertErr),
            },
          );
        } else {
          emitContractArchivePartialRecoveryFailed(
            ctx.audit,
            {
              contractId,
              context: contextLabel,
              message: 'archive failed and rollback to running also failed; set archive_pending_recovery for boot reconcile',
              error: formatErr(revertErr),
            },
          );
        }
      } catch (stateErr) {
        emitContractArchivePartialRecoveryFailed(
          ctx.audit,
          {
            contractId,
            context: `${contextLabel}.setPendingRecovery`,
            message: 'archive failed, rollback failed, and setting archive_pending_recovery also failed',
            error: formatErr(stateErr),
          },
        );
      }
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
  if (!contractYaml) {
    throw new ToolError(`Contract "${contractId}" unloadable: contract.yaml schema corruption`);
  }

  await ctx.withProgressLock(contractId, async () => {
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
    if (!progressAfterLock) {
      throw new ToolError(`Contract "${contractId}" progress unavailable: schema corruption`);
    }
    if (progressAfterLock.status === 'cancelled') {
      emitContractCompleteOnCancelled(ctx.audit, { contractId, subtaskId });
      return { ...result, allCompleted: false };
    }
    await archiveAndEmit(ctx, contractId, contractYaml, 'ContractSystem._completeSubtaskSync');
  }

  return { ...result, allCompleted };
}
