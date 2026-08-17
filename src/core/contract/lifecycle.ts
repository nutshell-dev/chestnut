/**
 * @module L4.ContractSystem.Lifecycle
 * Contract status transitions: cancel / archive / completion check (phase 1123 Step C)
 */

import type { ContractId, ArchiveState, LifecycleIntent, LifecycleCommitOutcome } from './types.js';
import type { ContractYaml } from './types.js';
import type { ProgressData } from './types.js';

import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { isAlive as defaultL1IsAlive } from '../../foundation/process-exec/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { ToolError } from '../../foundation/tools/index.js';
import type { ContractCorruptionEvidence } from './types.js';
import type { ContractFailure } from './types.js';

import {
  emitContractCancelled,
  emitContractCorrupted,
  emitContractFailed,
  emitContractNotifyFailed,
} from './audit-emit.js';
import type { ContractNotification, ContractNotificationSink } from './notification.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

import { type ArchiveDir } from './types.js';
import { archiveStateContainerDir, resolveContractLocation } from './locations.js';
import {
  persistLifecycleIntent,
  readLifecycleIntentsForContract,
  buildCancelledIntent,
  buildCorruptedIntent,
  buildFailedIntent,
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
  checkAllSubtasksCompleted: (contractId: ContractId, progress: ProgressData) => Promise<boolean>;
  /** phase 1020 (r124 C fork): cancelContract abort propagation to active verifier subagents */
  abortContractVerifiers: (contractId: ContractId, reason: string) => void;
  /** phase 63: onNotify sink for contract terminal state alerts（phase 1260: typed event） */
  onNotify?: ContractNotificationSink;
}

function makeRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${newShortUuid()}`;
}

function safeNotify(
  ctx: LifecycleContext,
  event: ContractNotification,
): void {
  try {
    ctx.onNotify?.(event);
  } catch (err) {
    emitContractNotifyFailed(ctx.audit, { notifyType: event.type, error: formatErr(err) });
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
    let abortVerifierFailed: string | undefined;
    try {
      ctx.abortContractVerifiers(contractId, reason);
    } catch (abortErr) {
      // Abort failure does not undo the terminal commit; record it on the
      // cancelled audit so the decision chain stays reconstructible.
      abortVerifierFailed = formatErr(abortErr);
    }
    emitContractCancelled(ctx.audit, { contractId, reason, abortVerifierFailed });
    safeNotify(ctx, {
      type: 'contract_cancelled',
      contractId,
      reason,
    } satisfies ContractNotification);
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

  try {
    await ctx.fs.moveDir(sourceRoot, targetRoot);
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
      committed: loc.state!,
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
    let abortVerifierFailed: string | undefined;
    try {
      ctx.abortContractVerifiers(contractId, evidence.reason);
    } catch (abortErr) {
      // Abort failure does not undo the terminal commit; record it on the
      // corrupted audit so the decision chain stays reconstructible.
      abortVerifierFailed = formatErr(abortErr);
    }
    emitContractCorrupted(ctx.audit, {
      contractId,
      reason: evidence.reason,
      evidencePath: evidence.relativePath,
      abortVerifierFailed,
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

/**
 * Phase 1396 Step D: ContractSystem-owned execution-failure terminal commit.
 *
 * Same immutable intent + rename winner protocol as cancel/corrupted. Only the
 * committed winner emits `contract_failed` audit + notification; cancelled stays
 * reserved for explicit business cancellation and is never used for failure.
 */
export async function failContract(
  ctx: LifecycleContext,
  contractId: ContractId,
  failure: ContractFailure,
  requestId?: string,
): Promise<LifecycleCommitOutcome> {
  // Caller-driven retry reuses the same requestId. Re-read the persisted intent
  // so the retry is payload-identical (requested_at included) and the exclusive
  // persist stays idempotent instead of tripping the collision guard.
  let intent: LifecycleIntent | undefined;
  if (requestId !== undefined) {
    const { intents } = await readLifecycleIntentsForContract(ctx.fs, ctx.audit, ctx.baseDir, contractId);
    const existing = intents.find(i => i.request_id === requestId);
    if (existing !== undefined) {
      if (
        existing.requested_state !== 'failed' ||
        existing.failure.reason !== failure.reason ||
        existing.failure.evidenceRef !== failure.evidenceRef ||
        existing.failure.producer !== failure.producer
      ) {
        throw new ToolError(
          `Lifecycle intent collision for request "${requestId}" on contract "${contractId}"`,
        );
      }
      intent = existing;
    }
  }
  intent ??= buildFailedIntent(
    contractId,
    requestId ?? makeRequestId('fail'),
    failure,
  );
  const outcome = await commitTerminalLifecycle(ctx, contractId, intent);

  if (outcome.kind === 'committed') {
    let abortVerifierFailed: string | undefined;
    try {
      ctx.abortContractVerifiers(contractId, failure.reason);
    } catch (abortErr) {
      // Abort failure does not undo the terminal commit; record it on the
      // failed audit so the decision chain stays reconstructible.
      abortVerifierFailed = formatErr(abortErr);
    }
    emitContractFailed(ctx.audit, {
      contractId,
      reason: failure.reason,
      evidenceRef: failure.evidenceRef,
      producer: failure.producer,
      abortVerifierFailed,
    });
    safeNotify(ctx, {
      type: 'contract_failed',
      contractId,
      reason: failure.reason,
      evidenceRef: failure.evidenceRef,
      producer: failure.producer,
    } satisfies ContractNotification);
    return outcome;
  }

  // already_committed / lost_to_state / retryable_failure: no success side
  // effects; the committed winner (possibly a different terminal state) owns them.
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
 * the business precondition (all subtasks completed). Cancelled/corrupted/failed
 * intents have no precondition beyond an active directory.
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
      } catch (progressErr) {
        // Precondition cannot be evaluated for this intent; commitTerminalLifecycle
        // will classify the race. Record why the completed check was skipped so
        // the replay decision is reconstructible from audit alone.
        ctx.audit.write(
          CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE_INTENT_SKIPPED,
          `contract=${contractId}`,
          `requestId=${intent.request_id}`,
          `requested_state=completed`,
          'reason=progress_read_failed',
          `error=${formatErr(progressErr)}`,
        );
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
      committed = outcome.state;
    } else if (outcome.kind === 'lost_to_state') {
      committed = outcome.committed;
    }

    const outcomeCols: string[] = [
      `contract=${contractId}`,
      `requestId=${intent.request_id}`,
      `requested_state=${intent.requested_state}`,
      `outcome=${outcome.kind}`,
    ];
    if (outcome.kind === 'committed' || outcome.kind === 'already_committed') {
      outcomeCols.push(`state=${outcome.state}`);
    }
    if (outcome.kind === 'lost_to_state') {
      outcomeCols.push(`committed_state=${outcome.committed}`);
    }
    if (outcome.kind === 'retryable_failure') {
      outcomeCols.push(`cause=${outcome.cause}`);
    }
    ctx.audit.write(CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_RECONCILE_INTENT_OUTCOME, ...outcomeCols);
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

