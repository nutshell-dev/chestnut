/**
 * @module L3.SubAgent.ExecutionReference
 * Disk-backed references, read-only open, terminal replay and resume admission.
 * No LLM/tool runner is constructed or invoked by this module (Step D scope).
 */

import * as path from 'node:path';
import { formatErr } from '../../foundation/node-utils/index.js';
import { SUBAGENT_EXECUTION_DIR } from './constants.js';
import {
  normalizeSubagentLocation,
  SubagentExecutionStore,
  SubagentExecutionStoreError,
  SubagentOwnerUnavailableError,
  type SubagentAttemptClaim,
  type SubagentAttemptWriter,
  type SubagentClaimResult,
  type SubagentTransitionResult,
} from './execution-store.js';
import type {
  SubagentExecutionIdentity,
  SubagentExecutionLocation,
  SubagentJsonValue,
  SubagentExecutionObserver,
  SubagentExecutionOptions,
  SubagentExecutionQuery,
  SubagentExecutionRef,
  SubagentExecutionView,
  SubagentFinalOutcome,
  SubagentObservation,
  SubagentRunner,
  SubagentSettlementInput,
  SubagentStartRequest,
  SubagentResumeRequest,
  SubagentStopReceipt,
  SubagentTransition,
} from './execution-types.js';

type Listener = (view: SubagentExecutionView) => void;

/** Process-local capabilities owned by the Step D runner, never persisted with a reference. */
interface SubagentExecutionRuntime {
  stop(reason: unknown): void;
  addSignal(signal: AbortSignal): void;
  /** Called after outcome commit and before completion is released. Must be idempotent. */
  close(): void;
}

export interface SubagentRunnerExecutionHooks {
  start(
    ref: SubagentExecutionReference,
    request: {
      readonly input: SubagentJsonValue;
      readonly signal?: AbortSignal;
      readonly deadlineAtMs?: number;
      readonly resume: boolean;
    },
  ): void;
}

/** Concrete owner references expose record transition/settlement to the execution runner. */
export class SubagentExecutionReference implements SubagentExecutionRef, SubagentExecutionObserver {
  readonly completion: Promise<SubagentFinalOutcome>;

  private resolveCompletion!: (outcome: SubagentFinalOutcome) => void;
  private current: SubagentExecutionView;
  private readonly listeners = new Map<Listener, number>();
  private runtime?: SubagentExecutionRuntime;
  private completionHeld = false;

  constructor(
    private readonly store: SubagentExecutionStore,
    readonly identity: SubagentExecutionIdentity,
    initial: SubagentExecutionView,
    private readonly writer?: SubagentAttemptWriter,
    private readonly onObserverError?: (error: unknown, identity: SubagentExecutionIdentity) => void,
  ) {
    this.current = initial;
    this.completion = new Promise(resolve => { this.resolveCompletion = resolve; });
    this.store.subscribe(identity, view => { this.publish(view); });
    if (initial.outcome) this.resolveCompletion(initial.outcome);
  }

  get view(): SubagentExecutionView { return this.current; }
  get ownsClaim(): boolean { return this.writer !== undefined; }

  /** @internal Bind the live owner immediately after claim admission. */
  bindRuntime(runtime: SubagentExecutionRuntime): void {
    if (this.runtime) throw new SubagentExecutionStoreError('conflict', 'execution runtime is already bound');
    this.runtime = runtime;
    this.completionHeld = true;
  }

  /** @internal Duplicate start/resume attaches another parent without replacing the owner. */
  attachSignal(signal?: AbortSignal): void {
    if (signal) this.runtime?.addSignal(signal);
  }

  async read(): Promise<SubagentExecutionView> {
    const view = await this.store.readView(this.identity);
    this.publish(view);
    return this.current;
  }

  observe(listener: Listener): () => void {
    // Register before the initial snapshot/read. Every listener has its own high-water mark.
    this.listeners.set(listener, -1);
    this.notify(listener, this.current);
    void this.read().catch(error => { this.observerError(error); });
    return () => { this.listeners.delete(listener); };
  }

  async requestStop(reason: unknown): Promise<SubagentStopReceipt> {
    if (!this.writer) {
      return {
        identity: this.identity,
        accepted: false,
        state: this.current.state,
        reason,
        persisted: false,
        durable: false,
        persistence: {
          path: path.join(this.store.executionDir, 'stops'),
          kind: 'unavailable',
          persisted: false,
          durable: false,
          error: 'this reference does not own the attempt claim',
        },
      };
    }
    const receipt = await this.writer.requestStop(reason);
    // A stop receipt is not a terminal outcome. Signal the original execution even
    // when stop-intent persistence failed; only actual convergence may settle it.
    if (receipt.accepted) this.runtime?.stop(reason);
    return receipt;
  }

  /** @internal Owner capability used by Step D, never by open/read-only references. */
  transition(change: SubagentTransition): Promise<SubagentTransitionResult> {
    if (!this.writer) throw new SubagentExecutionStoreError('conflict', 'read-only reference cannot transition an attempt');
    return this.writer.transition(change);
  }

  /** @internal Owner capability used by Step D, never by open/read-only references. */
  async settle(outcome: SubagentSettlementInput): Promise<SubagentFinalOutcome> {
    if (!this.writer) throw new SubagentExecutionStoreError('conflict', 'read-only reference cannot settle an attempt');
    const final = await this.writer.settle(outcome);
    if (this.completionHeld) {
      // Disk outcome is committed before the stream/owner writer is closed. The
      // completion promise remains gated until both have actually happened.
      try {
        this.runtime?.close();
      } finally {
        this.completionHeld = false;
        this.resolveCompletion(final);
      }
    }
    return final;
  }

  private publish(view: SubagentExecutionView): void {
    if (view.sequence < this.current.sequence) return;
    // If outcome publication failed, disk can only replay recovery_required. Keep
    // the owner's already-delivered final evidence so resume can distinguish an
    // actually settled attempt from a still-running process in this module.
    const next = this.current.outcome && !view.outcome
      ? { ...view, outcome: this.current.outcome }
      : view;
    this.current = next;
    for (const listener of [...this.listeners.keys()]) this.notify(listener, next);
    if (next.outcome && !this.completionHeld) this.resolveCompletion(next.outcome);
  }

  private notify(listener: Listener, view: SubagentExecutionView): void {
    const previous = this.listeners.get(listener);
    if (previous === undefined || previous >= view.sequence) return;
    this.listeners.set(listener, view.sequence);
    try {
      listener(view);
    } catch (error) {
      this.observerError(error);
    }
  }

  private observerError(error: unknown): void {
    try {
      if (this.onObserverError) this.onObserverError(error, this.identity);
      else process.stderr.write(`[subagent] execution observer failed for ${this.identity.runId}/${this.identity.attemptId}: ${formatErr(error)}\n`);
    } catch (nested) {
      process.stderr.write(`[subagent] observer error handler failed: ${formatErr(nested)}\n`);
    }
  }
}

interface CachedExecution {
  readonly ref: SubagentExecutionReference;
}

const active = new Map<string, CachedExecution>();
const admissions = new Map<string, Promise<unknown>>();

function cacheKey(location: SubagentExecutionLocation, fs: SubagentExecutionOptions['fs']): string {
  // Narrow legacy test doubles predating FileSystem.resolve remain usable; real
  // stores always resolve to the canonical absolute execution location.
  const resolved = typeof fs.resolve === 'function' ? fs.resolve(location.resultDir) : location.resultDir;
  return `${resolved}\0${location.runId}`;
}

function normalizeQuery(query: SubagentExecutionQuery): { location: SubagentExecutionLocation; attemptId?: string } {
  const location = normalizeSubagentLocation(query);
  if (query.attemptId !== undefined && query.attemptId.trim() === '') {
    throw new SubagentExecutionStoreError('conflict', 'attemptId must be non-empty when provided');
  }
  return { location, ...(query.attemptId !== undefined ? { attemptId: query.attemptId } : {}) };
}

export class SubagentRunnerImpl implements SubagentRunner {
  constructor(
    private readonly options: SubagentExecutionOptions,
    private readonly executionHooks?: SubagentRunnerExecutionHooks,
  ) {}

  private store(location: SubagentExecutionLocation): SubagentExecutionStore {
    return new SubagentExecutionStore({ ...this.options, resultDir: location.resultDir });
  }

  private serialize<T>(location: SubagentExecutionLocation, operation: () => Promise<T>): Promise<T> {
    const key = cacheKey(location, this.options.fs);
    const previous = admissions.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const barrier = result.then(() => undefined, () => undefined);
    admissions.set(key, barrier);
    void barrier.then(() => {
      if (admissions.get(key) === barrier) admissions.delete(key);
    });
    return result;
  }

  start(request: SubagentStartRequest): Promise<SubagentExecutionReference> {
    const location = normalizeSubagentLocation(request);
    return this.serialize(location, async () => {
      const store = this.store(location);
      const prepared = await store.prepareInput(location, request.input);
      const latest = await store.latestClaim(location.runId);
      if (!latest) {
        const claimed = await store.claimAttempt({
          location,
          inputDigest: prepared.document.inputDigest,
          ordinal: 1,
          parentAttemptId: null,
          startBasis: 'start',
          deadlineAtMs: request.deadlineAtMs,
        });
        return this.admitClaimed(store, location, claimed, {
          input: prepared.document.input,
          signal: request.signal,
          deadlineAtMs: request.deadlineAtMs,
          resume: false,
        });
      }
      if (latest.inputDigest !== prepared.document.inputDigest) {
        throw new SubagentExecutionStoreError('conflict', `claim input digest differs from ${location.runId}`);
      }
      return this.attachExisting(store, location, latest, request.signal);
    });
  }

  resume(request: SubagentResumeRequest): Promise<SubagentExecutionReference> {
    const location = normalizeSubagentLocation(request);
    return this.serialize(location, async () => {
      if (request.previousAttemptId.trim() === '') {
        throw new SubagentExecutionStoreError('conflict', 'previousAttemptId must be non-empty');
      }
      const store = this.store(location);
      const prepared = await store.prepareInput(location, request.input);
      const latest = await store.latestClaim(location.runId);
      if (!latest) throw new SubagentExecutionStoreError('not_found', `cannot resume ${location.runId}: no previous attempt`);
      if (latest.inputDigest !== prepared.document.inputDigest) {
        throw new SubagentExecutionStoreError('conflict', `resume input differs for ${location.runId}`);
      }
      if (latest.attemptId !== request.previousAttemptId) {
        // A competing resumer may already have won the next ordinal. Re-read and
        // attach that exact successor instead of acquiring another execution right.
        if (latest.parentAttemptId === request.previousAttemptId
            && latest.startBasis.kind === 'resume'
            && latest.startBasis.previousAttemptId === request.previousAttemptId) {
          return this.attachExisting(store, location, latest, request.signal);
        }
        throw new SubagentExecutionStoreError('conflict', `previousAttemptId is not the latest attempt for ${location.runId}`);
      }
      const previous = await store.read(location.runId, latest.attemptId);
      if (previous.kind !== 'found') {
        throw new SubagentExecutionStoreError(previous.kind === 'not_found' ? 'not_found' : 'corrupt', `cannot resume unreadable attempt ${latest.attemptId}`);
      }
      const cached = active.get(cacheKey(location, this.options.fs));
      const actualSettled = cached?.ref.identity.attemptId === latest.attemptId && cached.ref.view.outcome !== undefined;
      if (previous.view.state !== 'settled' && !actualSettled) {
        let owner;
        try {
          owner = store.inspectOwner(latest);
        } catch (error) {
          throw new SubagentOwnerUnavailableError(location, 'ProcessRef inspection threw', { cause: error });
        }
        if (owner.kind === 'alive') {
          throw new SubagentOwnerUnavailableError(location, 'existing owner is alive; takeover forbidden');
        }
        if (owner.kind === 'unknown') {
          throw new SubagentOwnerUnavailableError(location, `existing owner is unknown/${owner.reason}; takeover forbidden`);
        }
      }
      const claimed = await store.claimAttempt({
        location,
        inputDigest: prepared.document.inputDigest,
        ordinal: latest.ordinal + 1,
        parentAttemptId: latest.attemptId,
        startBasis: 'resume',
        deadlineAtMs: latest.deadlineAtMs,
      });
      return this.admitClaimed(store, location, claimed, {
        input: prepared.document.input,
        signal: request.signal,
        deadlineAtMs: latest.deadlineAtMs,
        resume: true,
      });
    });
  }

  private async admitClaimed(
    store: SubagentExecutionStore,
    location: SubagentExecutionLocation,
    result: SubagentClaimResult,
    execution: {
      readonly input: SubagentJsonValue;
      readonly signal?: AbortSignal;
      readonly deadlineAtMs?: number;
      readonly resume: boolean;
    },
  ): Promise<SubagentExecutionReference> {
    if (result.kind === 'existing') return this.attachExisting(store, location, result.claim, execution.signal);
    const prepared = await result.writer.transition({ state: 'prepared', reason: { kind: 'claim_acquired' } });
    if (!prepared.event.persisted) {
      throw new SubagentExecutionStoreError(
        'persistence',
        `claim acquired but initial event failed: ${prepared.event.error ?? 'unknown'}`,
        prepared.event.path,
      );
    }
    const ref = new SubagentExecutionReference(store, result.writer.claim, prepared.view, result.writer, this.options.onObserverError);
    active.set(cacheKey(location, this.options.fs), { ref });
    this.executionHooks?.start(ref, execution);
    return ref;
  }

  private async attachExisting(
    store: SubagentExecutionStore,
    location: SubagentExecutionLocation,
    claim: SubagentAttemptClaim,
    signal?: AbortSignal,
  ): Promise<SubagentExecutionReference> {
    const cached = active.get(cacheKey(location, this.options.fs));
    if (cached?.ref.identity.attemptId === claim.attemptId) {
      // Cache only the handle/subscription; every admission refreshes disk state.
      await cached.ref.read();
      cached.ref.attachSignal(signal);
      return cached.ref;
    }
    const view = await store.readView(claim);
    const ref = new SubagentExecutionReference(store, claim, view, undefined, this.options.onObserverError);
    active.set(cacheKey(location, this.options.fs), { ref });
    return ref;
  }

  async open(query: SubagentExecutionQuery): Promise<SubagentObservation> {
    const normalized = normalizeQuery(query);
    const store = this.store(normalized.location);
    let read;
    try {
      read = await store.read(normalized.location.runId, normalized.attemptId);
    } catch (error) {
      return this.corruptObservation(normalized.location, error);
    }
    if (read.kind === 'corrupt') {
      return {
        kind: 'corrupt',
        ...normalized.location,
        ...(read.path ? { path: read.path } : {}),
        reason: read.reason,
      };
    }
    if (read.kind === 'not_found') return this.openMissing(store, normalized.location);
    const identity = read.claim;
    const cached = active.get(cacheKey(normalized.location, this.options.fs));
    const activeRef = cached?.ref.identity.attemptId === identity.attemptId ? cached.ref : undefined;
    let view = read.view;
    if (activeRef) {
      try {
        view = await activeRef.read();
      } catch (error) {
        return this.corruptObservation(normalized.location, error);
      }
    }
    // Join the active owner's process-local subscription without exposing its
    // claim writer or requestStop control through this read-only observation.
    const ref: SubagentExecutionObserver = activeRef
      ? {
          identity: activeRef.identity,
          read: () => activeRef.read(),
          observe: listener => activeRef.observe(listener),
        }
      : new SubagentExecutionReference(store, identity, view, undefined, this.options.onObserverError);
    if (view.state === 'settled') {
      return { kind: 'found', ...normalized.location, identity, view, ref, owner: 'settled' };
    }
    let owner;
    try {
      owner = store.inspectOwner(read.claim);
    } catch (error) {
      return {
        kind: 'owner_unavailable',
        ...normalized.location,
        identity,
        view,
        ref,
        reason: `ProcessRef inspection threw: ${formatErr(error)}`,
      };
    }
    if (owner.kind === 'unknown') {
      return {
        kind: 'owner_unavailable',
        ...normalized.location,
        identity,
        view,
        ref,
        reason: `${owner.reason}: ${formatErr(owner.evidence)}`,
      };
    }
    return { kind: 'found', ...normalized.location, identity, view, ref, owner: owner.kind };
  }

  private async openMissing(store: SubagentExecutionStore, location: SubagentExecutionLocation): Promise<SubagentObservation> {
    try {
      if (await store.exists(path.join(location.resultDir, SUBAGENT_EXECUTION_DIR))) {
        return { kind: 'not_found', ...location };
      }
      if (!(await store.exists(location.resultDir))) return { kind: 'not_found', ...location };
      const candidates = ['recovery/cursor.json', 'messages.json', 'result.txt', 'stream.jsonl', 'audit.tsv'];
      const artifacts: string[] = [];
      for (const candidate of candidates) {
        if (await store.exists(path.join(location.resultDir, candidate))) artifacts.push(candidate);
      }
      // An existing old result directory is legacy even when no known artifact remains;
      // absence of execution/ is never evidence that no execution happened.
      return { kind: 'legacy', ...location, artifacts };
    } catch (error) {
      return this.corruptObservation(location, error);
    }
  }

  private corruptObservation(location: SubagentExecutionLocation, error: unknown): SubagentObservation {
    return {
      kind: 'corrupt',
      ...location,
      ...(error instanceof SubagentExecutionStoreError && error.recordPath ? { path: error.recordPath } : {}),
      reason: formatErr(error),
    };
  }
}

export function createSubagentRunner(options: SubagentExecutionOptions): SubagentRunnerImpl {
  return new SubagentRunnerImpl(options);
}
