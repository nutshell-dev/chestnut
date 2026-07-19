/**
 * @module L4.ContractSystem.Verification.Lifecycle
 * Lifecycle ops — archive + emit + subtask complete
 */

import * as path from 'path';
import type { VerificationContext } from './verification-types.js';
import type { VerificationResult, SubtaskId, ProgressData } from './types.js';
import { activeContainerDir } from './locations.js';
import { safeNotify } from './verification-notify.js';
import { formatValidIds } from './verification-format.js';
import { ToolError } from '../../foundation/tools/errors.js';
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
} from './audit-emit.js';

export async function archiveAndEmit(
  ctx: VerificationContext,
  contractId: ContractId,
  contractYaml: ContractYaml,
  contextLabel: string,
): Promise<{ archived: boolean }> {
  // Phase 1: emit contract completed BEFORE move (if fails, contract stays active for retry)
  try {
    await ctx.emitContractCompleted(contractId);
  } catch (emitErr) {
    emitContractMoveArchiveFailed(
      ctx.audit,
      {
        context: contextLabel,
        message: 'emitContractCompleted failed, cannot archive',
        error: formatErr(emitErr),
      },
    );
    return { archived: false };
  }

  // Phase 2: commit — move to archive (irreversible)
  try {
    await ctx.moveContractToArchive(contractId, 'completed');
  } catch (err) {
    // Step D: move failed before lifecycle commit. Directory rename is the only
    // commit point; failure leaves the contract in active/ for retry. No status
    // rollback or pending-recovery marker is written.
    emitContractMoveArchiveFailed(
      ctx.audit,
      {
        context: contextLabel,
        message: 'move failed before lifecycle commit; remains active for retry',
        error: formatErr(err),
      },
    );
    return { archived: false };
  }

  // COMMIT POINT: both emit and move succeeded. Side-effect failures do NOT roll back.
  // Phase 3: audit + best-effort notification
  try {
    emitContractCompleted(
      ctx.audit,
      { contractId, title: contractYaml.title, claw: ctx.clawId },
    );
  } catch {
    // audit failure should not affect downstream side effects
  }

  let progress: ProgressData | null = null;
  try {
    progress = await ctx.getProgress(contractId);
  } catch {
    // silent: best-effort notify, getProgress I/O failure is non-critical here
  }

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

  return { archived: true };
}

async function isContractActive(ctx: VerificationContext, contractId: ContractId): Promise<boolean> {
  try {
    const container = await ctx.contractDir(contractId);
    return path.normalize(container) === path.normalize(activeContainerDir());
  } catch {
    return false;
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

  // Phase 1132 Step D: lifecycle guard based on physical active path.
  if (!(await isContractActive(ctx, contractId))) {
    emitContractVerificationResetFailed(
      ctx.audit,
      {
        contractId,
        subtaskId,
        context: 'completeSubtaskSync',
        message: 'contract is not active, cannot complete subtask',
      },
    );
    return { passed: false, feedback: `Contract "${contractId}" is not active, cannot complete subtask "${subtaskId}".`, allCompleted: false };
  }

  await ctx.withProgressLock(contractId, async () => {
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      throw new ToolError(`Contract "${contractId}" progress unavailable: schema corruption`);
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

    allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
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
    // Phase 1132 Step D: contract may have been cancelled between lock release and now.
    if (!(await isContractActive(ctx, contractId))) {
      emitContractCompleteOnCancelled(ctx.audit, { contractId, subtaskId });
      return { ...result, allCompleted: false };
    }
    await archiveAndEmit(ctx, contractId, contractYaml, 'ContractSystem._completeSubtaskSync');
  }

  return { ...result, allCompleted };
}
