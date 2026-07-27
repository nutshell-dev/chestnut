/**
 * @module L4.ContractSystem.Lifecycle
 * Contract status transitions: cancel / archive / completion check (phase 1123 Step C)
 */

import type { ContractId, ArchiveState, LifecycleIntent, LifecycleCommitOutcome } from './types.js';
import type { ContractYaml } from './types.js';
import type { ProgressData } from './types.js';
import { ARCHIVE_STATES } from './types.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { isAlive as defaultL1IsAlive } from '../../foundation/process-exec/index.js';
import { ToolError } from '../../foundation/tools/errors.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { ContractCorruptionEvidence } from './types.js';

import {
  emitContractCancelled,
  emitContractCorrupted,
  emitContractNotifyFailed,
  emitContractArchivePreconditionViolated,
  emitContractArchiveTargetExists,
} from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

import { type ArchiveDir } from './types.js';
import { archiveStateContainerDir, resolveContractLocation } from './locations.js';
import * as path from 'path';
import {
  persistLifecycleIntent,
  readLifecycleIntentsForContract,
  buildCancelledIntent,
  buildCorruptedIntent,
} from './lifecycle-intent.js';
import { newShortUuid } from '../../foundation/node-utils/index.js';

export interface LifecycleContext {
  fs: FileSystem;
  audit: AuditLog;
  l1IsAlive?: typeof defaultL1IsAlive;
  /** Phase 1198: clawDir / base directory for stable intent store. */
  baseDir: string;
  activeDir: string;
  archiveDir: ArchiveDir;
  contractDir: (contractId: ContractId) => Promise<string>;
  loadContract: (contractId: ContractId) => Promise<ContractYaml | null>;
  getProgress: (contractId: ContractId) => Promise<ProgressData | null>;
  saveProgress: (contractId: ContractId, progress: ProgressData, knownDir?: string) => Promise<void>;
  checkAllSubtasksCompleted: (contractId: ContractId, progress: ProgressData) => Promise<boolean>;
  /** phase 1020 (r124 C fork): cancelContract abort propagation to active verifier subagents */
  abortContractVerifiers: (contractId: ContractId, reason: string) => void;
  /** phase 63: onNotify callback for contract terminal state alerts */
  onNotify?: (type: string, data: Record<string, unknown>) => void;
}

function makeRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${newShortUuid()}`;
}

function safeNotify(
  ctx: LifecycleContext,
  type: 'contract_cancelled',
  data: Record<string, unknown>,
): void {
  try {
    ctx.onNotify?.(type, data);
  } catch (err) {
    emitContractNotifyFailed(ctx.audit, { notifyType: type, error: formatErr(err) });
  }
}

/**
 * Phase 1198 Step C: cancel an active contract via immutable intent + typed rename outcome.
 *
 * No progress.json mutation occurs before the directory rename. The sole lifecycle
 * commit is the move from active/<id> to archive/cancelled/<id>.
 */
export async function cancelContract(
  ctx: LifecycleContext,
  contractId: ContractId,
  reason: string,
  requestId?: string,
): Promise<LifecycleCommitOutcome> {
  const intent = buildCancelledIntent(
    contractId,
    requestId ?? makeRequestId('cancel'),
    reason,
  );
  const outcome = await commitTerminalLifecycle(ctx, contractId, intent);

  if (outcome.kind === 'committed') {
    try {
      ctx.abortContractVerifiers(contractId, reason);
    } catch {
      // best-effort abort after terminal commit
    }
    emitContractCancelled(ctx.audit, { contractId, reason });
    safeNotify(ctx, 'contract_cancelled', { contractId, reason });
    return outcome;
  }

  if (outcome.kind === 'already_committed') {
    // Idempotent: intent already present and archive state matches. Do not re-emit
    // success side effects; the original request owns those.
    return outcome;
  }

  if (outcome.kind === 'lost_to_state') {
    // Terminal state is already committed to a different archive state.
    // Return the real state without success side effects.
    return outcome;
  }

  // retryable_failure: intent is persisted, caller decides whether to retry.
  return outcome;
}

/**
 * Phase 1198 Step B: generic terminal lifecycle commit with tagged outcome.
 *
 * 1. Persist immutable intent in stable store.
 * 2. Attempt directory rename from active/<id> to archive/<state>/<id>.
 * 3. On move failure, re-resolve location and classify:
 *    - requested archive state → already_committed
 *    - other archive state    → lost_to_state
 *    - still active / missing → retryable_failure
 *    - ambiguity              → retryable_failure (fail-closed)
 *
 * Caller is responsible for any business precondition and post-commit side effects.
 */
/**
 * Strip the obsolete `checkpoint: null` field that creation persisted before Phase 1198.
 * Lifecycle reasons now live exclusively in the intent store; progress.json should not
 * carry a null checkpoint placeholder after terminal commit.
 *
 * This is a one-time cleanup mutation performed immediately before the directory rename.
 */
async function stripObsoleteCheckpoint(
  fs: FileSystem,
  contractRoot: string,
): Promise<void> {
  const progressPath = `${contractRoot}/progress.json`;
  try {
    const raw = await fs.read(progressPath);
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).checkpoint === null) {
      const { checkpoint: _removed, ...rest } = parsed as Record<string, unknown>;
      void _removed;
      await fs.writeAtomic(progressPath, JSON.stringify(rest, null, 2));
    }
  } catch {
    // Missing or unreadable progress.json is fine; the rename will move whatever exists.
  }
}

export async function commitTerminalLifecycle(
  ctx: LifecycleContext,
  contractId: ContractId,
  intent: LifecycleIntent,
): Promise<LifecycleCommitOutcome> {
  await persistLifecycleIntent(ctx.fs, ctx.audit, ctx.baseDir, intent);

  const targetState = intent.requested_state;
  const targetContainer = archiveStateContainerDir(ctx.archiveDir, targetState);
  await ctx.fs.ensureDir(targetContainer);
  const sourceRoot = `${ctx.activeDir}/${contractId}`;
  const targetRoot = `${targetContainer}/${contractId}`;

  // Phase 1198 Step C: remove the legacy null checkpoint placeholder before committing.
  await stripObsoleteCheckpoint(ctx.fs, sourceRoot);

  try {
    await ctx.fs.move(sourceRoot, targetRoot);
    return {
      kind: 'committed',
      state: targetState,
      requested: targetState,
      requestId: intent.request_id,
    };
  } catch (moveErr) {
    let loc: Awaited<ReturnType<typeof resolveContractLocation>>;
    try {
      loc = await resolveContractLocation({
        fs: ctx.fs,
        activeDir: ctx.activeDir,
        archiveDir: ctx.archiveDir,
        contractId,
        audit: ctx.audit,
      });
    } catch (resolveErr) {
      return {
        kind: 'retryable_failure',
        requested: targetState,
        requestId: intent.request_id,
        cause: `resolve failed: ${formatErr(resolveErr)}`,
      };
    }

    if (!loc) {
      return {
        kind: 'retryable_failure',
        requested: targetState,
        requestId: intent.request_id,
        cause: `move failed: ${formatErr(moveErr)}; contract not found after resolve`,
      };
    }

    if (loc.kind === 'active') {
      return {
        kind: 'retryable_failure',
        requested: targetState,
        requestId: intent.request_id,
        cause: `move failed: ${formatErr(moveErr)}; contract still active`,
      };
    }

    if (loc.kind === 'archived-legacy') {
      return {
        kind: 'retryable_failure',
        requested: targetState,
        requestId: intent.request_id,
        cause: `contract in legacy archive: ${loc.contractRoot}`,
      };
    }

    if (loc.state === targetState) {
      return {
        kind: 'already_committed',
        state: targetState,
        requested: targetState,
        requestId: intent.request_id,
      };
    }

    return {
      kind: 'lost_to_state',
      requested: targetState,
      committed: loc.state,
      requestId: intent.request_id,
    };
  }
}

/**
 * phase 1121 Step C: ContractSystem 纯资源 corruption 入口
 *
 * Phase 1198 Step C: migrate to immutable intent + typed rename outcome.
 * No progress.json mutation occurs before the directory rename.
 */
export async function markCorrupted(
  ctx: LifecycleContext,
  contractId: ContractId,
  evidence: ContractCorruptionEvidence,
  _knownDir?: string,
  requestId?: string,
): Promise<LifecycleCommitOutcome> {
  const intent = buildCorruptedIntent(
    contractId,
    requestId ?? makeRequestId('corrupted'),
    evidence,
  );
  const outcome = await commitTerminalLifecycle(ctx, contractId, intent);

  if (outcome.kind === 'committed') {
    try {
      ctx.abortContractVerifiers(contractId, evidence.reason);
    } catch {
      // best-effort abort after terminal commit
    }
    emitContractCorrupted(ctx.audit, {
      contractId,
      reason: evidence.reason,
      evidencePath: evidence.relativePath,
    });
    return outcome;
  }

  if (outcome.kind === 'already_committed') {
    return outcome;
  }

  if (outcome.kind === 'lost_to_state') {
    return outcome;
  }

  return outcome;
}

export interface ReconcilePendingIntentsResult {
  /** The terminal state that was ultimately committed, if any. */
  committed?: ArchiveState;
  /** One outcome per pending intent, in deterministic replay order. */
  outcomes: LifecycleCommitOutcome[];
}

/**
 * Phase 1198 Step D: boot reconcile pending lifecycle intents for an active contract.
 *
 * Replays every persisted terminal intent through `commitTerminalLifecycle` without
 * emitting success side effects (notify/contract_completed). The first successful
 * rename decides the final archive state; subsequent intents become
 * `already_committed` or `lost_to_state` request facts and remain in the store.
 *
 * `completed` intents are only replayed when the active contract currently satisfies
 * the business precondition (all subtasks completed). Cancelled/corrupted intents have
 * no precondition beyond an active directory.
 */
export async function reconcilePendingLifecycleIntents(
  ctx: LifecycleContext,
  contractId: ContractId,
): Promise<ReconcilePendingIntentsResult> {
  const { intents, issues } = await readLifecycleIntentsForContract(
    ctx.fs,
    ctx.audit,
    ctx.baseDir,
    contractId,
  );

  const outcomes: LifecycleCommitOutcome[] = [];
  let committed: ArchiveState | undefined;

  if (intents.length === 0 && issues.length === 0) {
    return { outcomes };
  }

  for (const intent of intents) {
    if (intent.requested_state === 'completed') {
      let progress: ProgressData | null = null;
      try {
        progress = await ctx.getProgress(contractId);
      } catch {
        // Active payload unreadable; let commitTerminalLifecycle classify the race.
      }
      if (progress && !(await ctx.checkAllSubtasksCompleted(contractId, progress))) {
        ctx.audit.write(
          CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE_INTENT_SKIPPED,
          `contract=${contractId}`,
          `requestId=${intent.request_id}`,
          `requested_state=completed`,
          'reason=business_precondition_not_met',
        );
        outcomes.push({
          kind: 'retryable_failure',
          requested: 'completed',
          requestId: intent.request_id,
          cause: 'business precondition not met: not all subtasks completed',
        });
        continue;
      }
    }

    const outcome = await commitTerminalLifecycle(ctx, contractId, intent);
    outcomes.push(outcome);

    if (outcome.kind === 'committed') {
      committed = outcome.state;
    } else if (outcome.kind === 'already_committed') {
      committed = outcome.state ?? committed;
    } else if (outcome.kind === 'lost_to_state') {
      committed = outcome.committed ?? committed;
    }

    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE_INTENT_OUTCOME,
      `contract=${contractId}`,
      `requestId=${intent.request_id}`,
      `requested_state=${intent.requested_state}`,
      `outcome=${outcome.kind}`,
      outcome.state ? `state=${outcome.state}` : '',
      (outcome as { committed?: ArchiveState }).committed ? `committed_state=${(outcome as { committed?: ArchiveState }).committed}` : '',
      outcome.cause ? `cause=${outcome.cause}` : '',
    );
  }

  return { committed, outcomes };
}

export async function isContractComplete(
  ctx: LifecycleContext,
  contractId: ContractId,
): Promise<boolean> {
  const progress = await ctx.getProgress(contractId);
  if (!progress) return false;
  return ctx.checkAllSubtasksCompleted(contractId, progress);
}

// phase 351: ARCHIVE_ALLOWED_STATUSES 复用 types.ts (ML#1 共用基础设施单源、mirror phase 347/348 pattern)

export async function moveContractToArchive(
  ctx: LifecycleContext,
  contractId: ContractId,
  targetState: ArchiveState,
): Promise<void> {
  if (!(ARCHIVE_STATES as ReadonlySet<string>).has(targetState)) {
    throw new ToolError(`Invalid archive state "${targetState}"`);
  }

  const dir = await ctx.contractDir(contractId);
  const normalizedDir = path.normalize(dir);
  const normalizedArchive = path.normalize(ctx.archiveDir);
  const isArchiveSource = normalizedDir === normalizedArchive || normalizedDir.startsWith(`${normalizedArchive}${path.sep}`);
  if (isArchiveSource) {
    // Already archived — idempotent no-op.
    return;
  }

  // Step D: archive precondition is based on business facts, not progress.status.
  // 'completed' requires all subtasks completed; 'cancelled'/'corrupted' are only
  // reached through their dedicated lifecycle entry points.
  if (targetState === 'completed') {
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      throw new ToolError(`Contract "${contractId}" progress unavailable: cannot archive`);
    }
    const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
    if (!allCompleted) {
      emitContractArchivePreconditionViolated(
        ctx.audit,
        { contractId, status: progress.status, context: 'moveContractToArchive.completed' },
      );
      throw new ToolError(
        `Contract "${contractId}" cannot be archived to completed: not all subtasks are completed`,
      );
    }
  }

  const targetDir = archiveStateContainerDir(ctx.archiveDir, targetState);
  await ctx.fs.ensureDir(targetDir);
  const dst = `${targetDir}/${contractId}`;

  try {
    if (await ctx.fs.exists(dst)) {
      emitContractArchiveTargetExists(ctx.audit, {
        contractId,
        targetPath: dst,
        context: 'moveContractToArchive',
      });
      throw new ToolError(`Cannot archive contract "${contractId}": target already exists at ${dst}`);
    }
    await ctx.fs.move(`${dir}/${contractId}`, dst);
  } catch (err) {
    throw err;
  }
}
