import {
  makeExternalAbortError,
  withCombinedAbortSignal,
  type LLMProvider,
} from '../llm-provider/index.js';
import { formatErr } from '../node-utils/index.js';
import { DEFAULT_LLM_TIMEOUT_MS, LLM_PROVIDER_SELECTION_TTL_MS } from './defaults.js';
import {
  classifyLLMError,
  getQuotaResetAtMs,
  getRetryAfterSec,
  getUserActionHint,
} from './errors.js';
import { LLMOrchestratorClosedError } from './errors.js';
import type { ProviderRuntime } from './provider-runtime.js';
import type { RecoveryLedger, RecoveryLedgerSnapshot } from './recovery-ledger.js';
import type { SharedRecoveryDecision } from './recovery.js';
import type {
  LLMCallOptions,
  LLMEventSink,
  LLMProbeResult,
  ProbeTargetReason,
} from './types.js';
import { computeDynamicCallTimeoutMs } from './utils.js';

export interface ProbeRecoveryLedger extends Pick<
  RecoveryLedger,
  'snapshot' | 'canProbe' | 'noteProviderSuccess' | 'noteFailure' | 'subscribeCommits'
> {}

export interface ProbeControllerDeps {
  runtime: ProviderRuntime;
  ledger: ProbeRecoveryLedger;
  events: LLMEventSink;
}

interface ProbeTarget {
  adapter: LLMProvider;
  breakerIndex: number;
  isFallback: boolean;
  identity: string;
  reason: ProbeTargetReason;
  nextCursor: number;
}

/** Owns autonomous provider probes and their process-local lifecycle. */
export class LLMProbeController {
  private readonly runtime: ProviderRuntime;
  private readonly ledger: ProbeRecoveryLedger;
  private readonly events: LLMEventSink;
  private readonly unsubscribeCommits: () => void;
  private inflightProbe: Promise<LLMProbeResult> | null = null;
  private probeAbort: AbortController | null = null;
  private probeCursor = 0;
  private readyListeners = new Set<() => void>();
  private scheduleTimer?: ReturnType<typeof setTimeout>;
  private scheduleGeneration = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(deps: ProbeControllerDeps) {
    this.runtime = deps.runtime;
    this.ledger = deps.ledger;
    this.events = deps.events;
    this.unsubscribeCommits = this.ledger.subscribeCommits(context => {
      if (context === 'noteFailure' && !this.closed) {
        this.scheduleProbe(this.nextAutonomousProbeAt());
      }
    });
    this.scheduleProbe(this.nextAutonomousProbeAt());
  }

  probe(): Promise<LLMProbeResult> {
    this.assertOpen();
    if (this.inflightProbe) return this.inflightProbe;
    this.inflightProbe = this.runProbe().finally(() => {
      this.inflightProbe = null;
    });
    return this.inflightProbe;
  }

  subscribeReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => { this.readyListeners.delete(listener); };
  }

  scheduleProbe(atMs: number): void {
    if (this.closed) return;
    const decision = this.getSharedRecoveryDecision();
    const effectiveAtMs = decision.kind === 'at' ? Math.max(atMs, decision.nextProbeAt) : atMs;
    const generation = ++this.scheduleGeneration;
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = undefined;
      if (generation !== this.scheduleGeneration || this.closed) return;
      const fireGeneration = this.runtime.configGeneration();
      const fireDecision = this.getSharedRecoveryDecision();
      if (fireDecision.kind === 'at' && fireDecision.nextProbeAt > Date.now()) {
        this.scheduleProbe(fireDecision.nextProbeAt);
        return;
      }
      const mergedIntoInflight = this.inflightProbe !== null;
      void this.probe().then(() => {
        if (this.closed || mergedIntoInflight || fireGeneration !== this.runtime.configGeneration()) return;
        const current = this.getSharedRecoveryDecision();
        if (current.kind === 'ready') {
          for (const listener of this.readyListeners) {
            try { listener(); } catch (error) {
              console.error('LLM ready listener failed', error); // console: listener 异常须 fail-soft 且保持可观察
            }
          }
          this.scheduleProbe(this.nextAutonomousProbeAt());
        } else if (current.kind === 'at') {
          this.scheduleProbe(current.nextProbeAt);
        }
      }).catch(error => {
        this.events.emit({ type: 'instance_state_write_failed', context: 'probe_timer', reason: formatErr(error) });
        if (!this.closed && fireGeneration === this.runtime.configGeneration()) {
          this.scheduleProbe(this.nextAutonomousProbeAt());
        }
      });
    }, Math.max(0, effectiveAtMs - Date.now()));
  }

  getSharedRecoveryDecision(): SharedRecoveryDecision {
    let minAtMs: number | undefined;
    const providerIds = this.runtime.providerIds();
    const snapshot = this.ledger.snapshot();
    for (const providerId of providerIds) {
      const state = snapshot.providers.find(provider => provider.providerId === providerId);
      if (state?.status !== 'waiting') return { kind: 'ready' };
      const floorMs = state.retryAt ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(floorMs)) continue;
      minAtMs = minAtMs === undefined ? floorMs : Math.min(minAtMs, floorMs);
    }
    return minAtMs === undefined
      ? { kind: 'on_change' }
      : { kind: 'at', nextProbeAt: minAtMs };
  }

  reload(): void {
    if (this.closed) return;
    this.probeCursor = 0;
    this.scheduleGeneration += 1;
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    this.scheduleProbe(this.nextAutonomousProbeAt());
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.scheduleGeneration += 1;
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    this.probeAbort?.abort();
    this.unsubscribeCommits();
    const inflight = this.inflightProbe;
    this.closePromise = inflight === null
      ? Promise.resolve()
      : inflight.then(() => undefined, () => undefined);
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) throw new LLMOrchestratorClosedError();
  }

  private nextAutonomousProbeAt(): number {
    let nextFailureAt: number | undefined;
    const snapshot = this.ledger.snapshot();
    for (const providerId of this.runtime.providerIds()) {
      const state = this.providerState(snapshot, providerId);
      if (state?.status !== 'waiting' || state.retryAt === undefined || !Number.isFinite(state.retryAt)) continue;
      nextFailureAt = nextFailureAt === undefined ? state.retryAt : Math.min(nextFailureAt, state.retryAt);
    }
    return nextFailureAt ?? Date.now() + LLM_PROVIDER_SELECTION_TTL_MS;
  }

  private pickProbeTarget(): ProbeTarget | undefined {
    const adapters = [this.runtime.primary(), ...this.runtime.fallbacks()];
    const providerIds = this.runtime.providerIds();
    const snapshot = this.ledger.snapshot();
    const entries = adapters.map((adapter, index) => {
      const identity = providerIds[index] ?? `unknown:${adapter.name}`;
      const state = snapshot.providers.find(provider => provider.providerId === identity);
      return {
        adapter,
        breakerIndex: index,
        isFallback: index > 0,
        identity,
        failed: state?.status === 'waiting',
        state,
      };
    });
    if (entries.length === 0) return undefined;
    if (!entries.some(entry => entry.failed)) {
      return { ...entries[0]!, reason: 'default_primary', nextCursor: 1 % entries.length };
    }
    const nowMs = Date.now();
    const canProbe = (entry: typeof entries[number]): boolean =>
      this.ledger.canProbe(entry.identity, nowMs);
    const start = this.probeCursor % entries.length;
    const ordered = [...entries.slice(start), ...entries.slice(0, start)];
    const primary = entries[0]!;
    const candidate = primary.failed && canProbe(primary)
      ? primary
      : ordered.find(entry => entry.failed && canProbe(entry))
        ?? ordered.find(canProbe);
    if (!candidate) return undefined;
    return {
      adapter: candidate.adapter,
      breakerIndex: candidate.breakerIndex,
      isFallback: candidate.isFallback,
      identity: candidate.identity,
      reason: candidate.failed ? 'expired_failure' : 'fairness_rotation',
      nextCursor: (candidate.breakerIndex + 1) % entries.length,
    };
  }

  private async runProbe(): Promise<LLMProbeResult> {
    const probedAtMs = Date.now();
    const generation = this.runtime.configGeneration();
    const target = this.pickProbeTarget();
    if (!target) {
      return {
        ok: false,
        provider: 'none',
        probedAtMs,
        error: 'no provider is currently eligible for probe',
        reason: 'recovery_floor',
      };
    }
    this.probeCursor = target.nextCursor;
    this.events.emit({
      type: 'probe_target_selected',
      provider: target.adapter.name,
      providerId: target.identity,
      reason: target.reason,
      nextCursor: target.nextCursor,
    });
    const snapshot = this.ledger.snapshot();
    const probeInvocationId = `probe:${snapshot.instanceId}:${probedAtMs}:${target.breakerIndex}`;
    const failureObservedAt = this.providerState(snapshot, target.identity)?.lastError?.at;
    const config = this.runtime.config();
    const targetConfig = target.breakerIndex === 0
      ? config.primary
      : config.fallbacks?.[target.breakerIndex - 1];
    const abort = new AbortController();
    this.probeAbort = abort;
    const dynamicTimeoutMs = computeDynamicCallTimeoutMs(targetConfig?.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS, 0);
    const hardTimeoutMs = targetConfig?.timeoutMs ?? dynamicTimeoutMs;
    const [hardSignal, cleanupSignal] = withCombinedAbortSignal(abort.signal, hardTimeoutMs);
    const probeOptions: LLMCallOptions = {
      messages: [{ role: 'user', content: 'ping' }],
      signal: hardSignal.signal,
      timeoutMs: dynamicTimeoutMs,
      ...(targetConfig?.maxTokens !== undefined ? { maxTokens: targetConfig.maxTokens } : {}),
    };
    try {
      await target.adapter.call(probeOptions);
      cleanupSignal();
      if (!this.closed && generation === this.runtime.configGeneration()) {
        const currentFailureAt = this.providerState(this.ledger.snapshot(), target.identity)?.lastError?.at;
        if (currentFailureAt === failureObservedAt) {
          this.ledger.noteProviderSuccess(target.identity, Date.now(), false);
        }
      }
      return { ok: true, provider: target.adapter.name, probedAtMs };
    } catch (error) {
      cleanupSignal();
      const observedAtMs = Date.now();
      const e = abort.signal.aborted
        ? makeExternalAbortError(abort.signal.reason)
        : error as Error;
      const errorClass = classifyLLMError(e);
      if (errorClass === 'context_exceeded') {
        this.events.emit({ type: 'context_exceeded_throwthrough', provider: target.adapter.name });
      } else if (!abort.signal.aborted && e.name !== 'AbortError') {
        this.events.emit({
          type: 'provider_attempt_failed',
          provider: target.adapter.name,
          attempt: 0,
          maxAttempts: 1,
          error: e.message,
          errorClass,
          userActionHint: getUserActionHint(e),
          ...(getRetryAfterSec(e) !== undefined ? { retryAfterSec: getRetryAfterSec(e) } : {}),
        });
        this.events.emit({ type: 'provider_exhausted', provider: target.adapter.name, error: e.message });
      }
      if (!this.closed && generation === this.runtime.configGeneration()
        && errorClass !== 'context_exceeded' && errorClass !== 'abort') {
        this.ledger.noteFailure([{
          providerId: target.identity,
          providerLabel: target.adapter.name,
          configRevision: generation,
          invocationId: probeInvocationId,
          attemptId: `${probeInvocationId}:attempt`,
          errorClass,
          message: e.message,
          occurredAtMs: observedAtMs,
          ...(getRetryAfterSec(e) !== undefined ? { retryAfterSec: getRetryAfterSec(e) } : {}),
          ...(getQuotaResetAtMs(e) !== undefined ? { resetAtMs: getQuotaResetAtMs(e) } : {}),
        }]);
      }
      return this.failedProbeResult(target.adapter.name, probedAtMs, e);
    } finally {
      if (this.probeAbort === abort) this.probeAbort = null;
    }
  }

  private failedProbeResult(provider: string, probedAtMs: number, error: Error): LLMProbeResult {
    return {
      ok: false,
      provider,
      probedAtMs,
      error: formatErr(error),
      errorClass: classifyLLMError(error),
      ...(getRetryAfterSec(error) !== undefined ? { retryAfterSec: getRetryAfterSec(error) } : {}),
    };
  }

  private providerState(snapshot: RecoveryLedgerSnapshot, providerId: string) {
    return snapshot.providers.find(provider => provider.providerId === providerId);
  }
}
