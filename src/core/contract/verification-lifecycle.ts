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
import { newShortUuid } from '../../foundation/node-utils/index.js';
import {
  commitTerminalLifecycle,
} from './lifecycle.js';
import {
  persistLifecycleIntent,
  buildCompletedIntent,
} from './lifecycle-intent.js';
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
): Promise<{ archived: boolean; state?: 'completed' | 'cancelled' | 'corrupted' }> {
  // Phase 1198 Step E: persist the immutable intent BEFORE checking the completed precondition.
  // A failed precondition still leaves a request fact for future boot replay.
  const requestId = `completed-${Date.now()}-${newShortUuid()}`;
  const lifecycleCtx = verificationToLifecycleContext(ctx);
  const intent = buildCompletedIntent(contractId, requestId, contextLabel);
  await persistLifecycleIntent(lifecycleCtx.fs, lifecycleCtx.audit, lifecycleCtx.baseDir, intent);

  let progress: ProgressData | null = null;
  try {
    progress = await ctx.getProgress(contractId);
  } catch (err) {
    emitContractMoveArchiveFailed(
      ctx.audit,
      {
        context: contextLabel,
        message: 'progress unavailable, cannot archive',
        error: formatErr(err),
      },
    );
    return { archived: false };
  }
  if (!progress) {
    emitContractMoveArchiveFailed(
      ctx.audit,
      {
        context: contextLabel,
        message: 'progress missing, cannot archive',
      },
    );
    return { archived: false };
  }
  const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
  if (!allCompleted) {
    emitContractMoveArchiveFailed(
      ctx.audit,
      {
        context: contextLabel,
        message: 'not all subtasks are completed',
      },
    );
    return { archived: false };
  }

  const outcome = await commitTerminalLifecycle(lifecycleCtx, contractId, intent);

  if (outcome.kind === 'retryable_failure') {
    emitContractMoveArchiveFailed(
      ctx.audit,
      {
        context: contextLabel,
        message: 'terminal commit failed',
        error: outcome.cause,
      },
    );
    return { archived: false };
  }

  if (outcome.kind === 'lost_to_state') {
    emitContractMoveArchiveFailed(
      ctx.audit,
      {
        context: contextLabel,
        message: `lost to ${outcome.committed}`,
      },
    );
    return { archived: false, state: outcome.committed };
  }

  // Side effects (abort, handler, audit, notify) belong ONLY to this committed request.
  if (outcome.kind === 'committed') {
    try {
      ctx.abortContractVerifiers(contractId, 'contract completed');
    } catch {
      // silent: best-effort abort after terminal commit
    }
    try {
      await ctx.emitContractCompleted(contractId);
    } catch {
      // silent: handler failures are audited inside _emitContractCompleted; outcome stands.
    }

    try {
      emitContractCompleted(
        ctx.audit,
        { contractId, title: contractYaml.title, claw: ctx.clawId },
      );
    } catch {
      // silent: audit failure should not affect downstream side effects
    }

    const subtasksSummary = Object.entries(progress.subtasks)
      .filter(([, st]) => st.status === 'completed')
      .map(([id, st]) => ({ id, completed_at: st.completed_at ?? '', force_accepted: !!st.force_accepted }));
    const completedAt = Object.values(progress.subtasks)
      .reduce((max, s) => {
        if (!s.completed_at) return max;
        return s.completed_at > max ? s.completed_at : max;
      }, '');

    safeNotify(ctx, 'contract_completed', {
      contractId,
      title: contractYaml.title,
      goal: contractYaml.goal,
      subtasks: subtasksSummary,
      completed_at: completedAt,
    });

    return { archived: true, state: 'completed' };
  }

  if (outcome.kind === 'already_committed') {
    return { archived: false, state: 'completed' };
  }

  return { archived: false };
}

function verificationToLifecycleContext(ctx: VerificationContext): {
  fs: VerificationContext['fs'];
  audit: VerificationContext['audit'];
  baseDir: string;
  activeDir: string;
  archiveDir: VerificationContext['archiveDir'];
  contractDir: (id: ContractId) => Promise<string>;
  loadContract: (id: ContractId) => Promise<ContractYaml | null>;
  getProgress: (id: ContractId) => Promise<ProgressData | null>;
  checkAllSubtasksCompleted: (id: ContractId, p: ProgressData) => Promise<boolean>;
  abortContractVerifiers: (id: ContractId, reason: string) => void;
} {
  return {
    fs: ctx.fs,
    audit: ctx.audit,
    baseDir: ctx.baseDir,
    activeDir: ctx.activeDir,
    archiveDir: ctx.archiveDir,
    contractDir: (id) => ctx.contractDir(id),
    loadContract: (id) => ctx.loadContractYaml(id),
    getProgress: (id) => ctx.getProgress(id),
    checkAllSubtasksCompleted: (id, p) => ctx.checkAllSubtasksCompleted(id, p),
    abortContractVerifiers: (id, reason) => ctx.abortContractVerifiers(id, reason),
  };
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
    return result;
  }

  const currentStatus = progress.subtasks[subtaskId].status;
  if (currentStatus === 'in_progress') {
    result = { passed: false, feedback: `Subtask "${subtaskId}" verification is already in progress — duplicate submit_subtask call ignored.` };
    emitContractSubtaskDuplicateDone(ctx.audit, { contractId, subtaskId });
    return result;
  }
  if (currentStatus === 'completed') {
    result = { passed: false, feedback: `Subtask "${subtaskId}" is already completed.` };
    emitContractSubtaskAlreadyCompleted(ctx.audit, { contractId, subtaskId });
    return result;
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
