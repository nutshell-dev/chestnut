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
 *   on terminal side effects (enforced by ratchet 规则 5).
 * - phase 1862 Step F (CT-D7): 泛型回调面收窄为 kind → typed result 映射
 *   （ProgressMutationResultMap，穷尽）；不存在 arbitrary-T enqueue 表面。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { ContractId, ProgressData } from './types.js';
import type { VerificationGatewayResult, SyncCompletionGatewayResult } from './verification-types.js';
import {
  emitProgressMutationFailed,
  emitProgressMutationFinished,
  emitProgressMutationQueued,
  emitProgressMutationStarted,
} from './audit-emit.js';

/** Phase 1201 Step C: queued boot reset mutation outcome（manager 消费，map 单源）。 */
export type BootResetMutationOutcome =
  | { kind: 'done'; resetIds: string[]; progress: ProgressData }
  | { kind: 'not_active' }
  | { kind: 'schema_failed' };

/** phase 1862 Step F (CT-D7): queued boot replay mutation outcome（map 单源）。 */
export type BootReplayMutationOutcome = {
  result: 'replayed' | 'already_applied' | 'superseded' | 'not_active' | 'invalid';
  detail?: string;
};

/**
 * phase 1862 Step F (CT-D7): per-kind typed mutation 协议。
 * kind 穷尽映射到各自 typed result——enqueue 不接受 arbitrary-T 回调。
 */
export interface ProgressMutationResultMap {
  sync_complete: SyncCompletionGatewayResult;
  attempt_start: VerificationGatewayResult;
  attempt_pass: VerificationGatewayResult;
  attempt_reject: VerificationGatewayResult;
  attempt_interrupt: VerificationGatewayResult;
  boot_replay: BootReplayMutationOutcome;
  boot_reset: BootResetMutationOutcome;
}

export type ProgressMutationKind = keyof ProgressMutationResultMap;

export interface ProgressMutationMeta<K extends ProgressMutationKind = ProgressMutationKind> {
  /** Caller-generated unique mutation id (audit correlation). */
  mutationId: string;
  kind: K;
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

  /**
   * phase 1862 Step F (CT-D7)：kind → typed result 协议（ProgressMutationResultMap
   * 穷尽）；返回型由 kind 决定，不接受 arbitrary-T 回调。
   */
  async enqueue<K extends ProgressMutationKind>(
    contractId: ContractId,
    meta: ProgressMutationMeta<K>,
    mutation: () => Promise<ProgressMutationResultMap[K]>,
  ): Promise<ProgressMutationResultMap[K]> {
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

    const run = (async (): Promise<ProgressMutationResultMap[K]> => {
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
