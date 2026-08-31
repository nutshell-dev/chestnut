/**
 * @module L4.ContractSystem.ProgressMutationQueue
 * Per-contract FIFO short-transaction queue for published active progress mutations.
 *
 * Phase 1201 Step A: queue primitive + owner wiring only; business callers migrate
 * in Step B/C.
 *
 * Semantics (see coding plan Phase 1201 总览 §queue 最小语义):
 * - FIFO per contract; different contracts may run in parallel.
 * - enqueue returns the mutation's own result/rejection.
 * - A rejecting mutation must not poison the following tail.
 * - After settle, the map entry is removed only when the tracked tail is still the
 *   current tail (identity compare), so a late `finally` never deletes a newer tail.
 * - `depth` is observability metadata only, never an authority.
 * - The callback receives no arguments: callers must not pass a pre-read mutable
 *   ProgressData snapshot; mutations fresh-read at execution time.
 * - The callback must not host long-running verifier/LLM/script computation or wait
 *   on terminal side effects (enforced by ratchet in Step D).
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { ContractId } from './types.js';
import {
  emitProgressMutationFailed,
  emitProgressMutationFinished,
  emitProgressMutationQueued,
  emitProgressMutationStarted,
} from './audit-emit.js';

/**
 * Typed mutation kinds. Step A introduces the primitive; later steps route
 * business mutations through these kinds.
 */
type ProgressMutationKind =
  | 'sync_complete'
  | 'attempt_start'
  | 'attempt_pass'
  | 'attempt_reject'
  | 'attempt_interrupt'
  | 'apply_outcome'
  | 'boot_replay'
  | 'boot_reset'
  | 'fallback_reset';

export interface ProgressMutationMeta {
  /** Caller-generated unique mutation id (audit correlation). */
  mutationId: string;
  kind: ProgressMutationKind;
}

interface PendingEntry {
  /** Number of mutations queued or running for this contract (observability). */
  depth: number;
  /** Current tail promise; never rejects (settlement observed via `run`). */
  tail: Promise<void>;
}

export class ProgressMutationQueue {
  private readonly entries = new Map<string, PendingEntry>();

  constructor(private readonly audit: AuditLog) {}

  /** Observability only: queued-or-running mutation count for a contract. */
  pendingCount(contractId: ContractId): number {
    return this.entries.get(contractId as string)?.depth ?? 0;
  }

  /** Observability only: number of contracts with a live tail. */
  get trackedContractCount(): number {
    return this.entries.size;
  }

  async enqueue<T>(
    contractId: ContractId,
    meta: ProgressMutationMeta,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const key = contractId as string;
    const existing = this.entries.get(key);
    const depth = (existing?.depth ?? 0) + 1;
    const prevTail = existing?.tail;

    emitProgressMutationQueued(this.audit, {
      contractId,
      mutationId: meta.mutationId,
      kind: meta.kind,
      depth,
    });

    const run = (async (): Promise<T> => {
      if (prevTail) await prevTail;
      emitProgressMutationStarted(this.audit, {
        contractId,
        mutationId: meta.mutationId,
        kind: meta.kind,
        depth,
      });
      try {
        const result = await mutation();
        emitProgressMutationFinished(this.audit, {
          contractId,
          mutationId: meta.mutationId,
          kind: meta.kind,
          depth,
        });
        return result;
      } catch (err) {
        emitProgressMutationFailed(this.audit, {
          contractId,
          mutationId: meta.mutationId,
          kind: meta.kind,
          depth,
          error: formatErr(err),
        });
        throw err;
      }
    })();

    // Tail continues regardless of this mutation's settlement (reject isolation).
    const trackedTail = run.then(
      () => undefined,
      () => undefined,
    );
    this.entries.set(key, { depth, tail: trackedTail });

    try {
      return await run;
    } finally {
      const current = this.entries.get(key);
      if (current) {
        // Identity-safe cleanup: only the latest tail may remove the entry; an
        // older settle must never delete a newer tail's entry.
        if (current.tail === trackedTail && current.depth <= 1) {
          this.entries.delete(key);
        } else {
          current.depth -= 1;
        }
      }
    }
  }
}
