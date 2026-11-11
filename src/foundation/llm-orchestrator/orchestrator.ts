/** Assembly and public recovery wrapper for the LLM orchestrator. */
import { type LLMResponse, isAbortError } from '../llm-provider/index.js';
import { classifyLLMError } from './errors.js';
import type {
  LLMOrchestratorConfig,
  LLMCallOptions,
  LLMEventSink,
  LLMInstanceSnapshot,
  LLMInstanceLifecycle,
  LLMOrchestrator,
  LLMProbeResult,
  LLMProviderHealthSnapshot,
  LLMRuntimeCapability,
  LLMFailureDisposition,
  LLMStreamChunk,
  InputBudgetRequest,
  InputBudgetResult,
} from './types.js';
import {
  LLMRecoveryControllerImpl,
  requestKeyForCall,
  type LLMOrchestratorOwner,
  type SharedRecoveryDecision,
} from './recovery.js';
import { LLMOrchestratorClosedError, LLMRecoveryWaitRequiredError } from './errors.js';
import { LLMInvocationExecutor, type InvocationExecutor } from './invocation-executor.js';
import { LLMProviderRuntime } from './provider-runtime.js';
import { LLMProviderAdmission } from './provider-admission.js';
import { LLMInstanceStateStore } from './instance-state-store.js';
import { LLMProbeController } from './probe-controller.js';

type InstanceConfig = LLMOrchestratorConfig & { lifecycle: LLMInstanceLifecycle };

export class LLMOrchestratorImpl implements LLMOrchestrator, LLMOrchestratorOwner, LLMRuntimeCapability {
  private readonly events: LLMEventSink;
  private readonly instanceStateStore: LLMInstanceStateStore;
  private readonly recoveryController: LLMRecoveryControllerImpl;
  private readonly providerRuntime: LLMProviderRuntime;
  private readonly invocationExecutor: InvocationExecutor;
  private readonly probeController: LLMProbeController;
  private closed = false;

  constructor(config: InstanceConfig) {
    this.events = config.events;
    const events: LLMEventSink = { emit: event => this.events?.emit(event) };
    this.providerRuntime = new LLMProviderRuntime({ ...config, events });
    this.instanceStateStore = new LLMInstanceStateStore({
      ...config.lifecycle,
      providerIds: this.providerRuntime.providerIds(),
      legacyProviderIds: this.providerRuntime.legacyProviderIds(),
      events,
    });
    this.instanceStateStore.load();
    const admission = new LLMProviderAdmission();
    this.recoveryController = new LLMRecoveryControllerImpl({
      store: this.instanceStateStore,
      providerIds: this.providerRuntime.providerIds(),
      legacyProviderIds: this.providerRuntime.legacyProviderIds(),
      admission,
      emit: event => events.emit(event),
    });
    this.invocationExecutor = new LLMInvocationExecutor({
      runtime: this.providerRuntime,
      admission,
      ledger: this.recoveryController,
      events,
    });
    this.probeController = new LLMProbeController({
      runtime: this.providerRuntime,
      ledger: this.recoveryController,
      events,
    });
    this.emitLegacyConfigIgnored(config);
  }

  private emitLegacyConfigIgnored(config: LLMOrchestratorConfig): void {
    if (config.circuitBreaker === undefined) return;
    this.events.emit({
      type: 'legacy_config_ignored',
      field: 'circuitBreaker',
      reason: 'provider_retry_at_policy',
      value: {
        failureThreshold: config.circuitBreaker.failureThreshold,
        resetTimeoutMs: config.circuitBreaker.resetTimeoutMs,
      },
    });
  }

  snapshot(): LLMInstanceSnapshot {
    return this.invocationExecutor.snapshot();
  }

  getProviderHealthSnapshot(): LLMProviderHealthSnapshot {
    return this.invocationExecutor.getProviderHealthSnapshot();
  }

  probe(): Promise<LLMProbeResult> {
    this.assertOpen();
    return this.probeController.probe();
  }

  subscribeReady(listener: () => void): () => void {
    return this.probeController.subscribeReady(listener);
  }

  scheduleProbe(atMs: number): void {
    this.probeController.scheduleProbe(atMs);
  }

  getSharedRecoveryDecision(): SharedRecoveryDecision {
    return this.probeController.getSharedRecoveryDecision();
  }

  getProviderIdentities(): readonly string[] {
    return [...this.providerRuntime.providerIds()];
  }

  getLegacyProviderIdentities(): readonly string[] {
    return [...this.providerRuntime.legacyProviderIds()];
  }

  async call(options: LLMCallOptions): Promise<LLMResponse> {
    this.assertOpen();
    const admission = await this.recoveryController.begin({
      requestKey: requestKeyForCall(options),
      facts: options.recoveryFacts ?? { interventionIds: [] },
    });
    if (admission.kind === 'waiting') {
      throw new LLMRecoveryWaitRequiredError(admission.schedule, admission.factsAccepted);
    }
    let outcome: 'completed' | 'interrupted' | 'failed' = 'completed';
    let invocationError: unknown;
    let hasInvocationError = false;
    try {
      try {
        return await this.invocationExecutor.call({ options, admission });
      } catch (error) {
        hasInvocationError = true;
        invocationError = error;
        outcome = isAbortError(error) ? 'interrupted' : 'failed';
        throw error;
      }
    } finally {
      try {
        await this.recoveryController.finish(admission.invocationId, admission.attemptId, outcome);
      } catch (finishError) {
        if (hasInvocationError) {
          throw new AggregateError([invocationError, finishError], 'LLM invocation and recovery finish both failed', { cause: invocationError });
        }
        throw finishError;
      }
    }
  }

  async inspectRecoverySchedule() {
    return this.recoveryController.inspect();
  }

  private assertOpen(): void {
    if (this.closed) throw new LLMOrchestratorClosedError();
  }

  isClosed(): boolean {
    return this.closed;
  }

  async* stream(options: LLMCallOptions): AsyncIterableIterator<LLMStreamChunk> {
    this.assertOpen();
    const admission = await this.recoveryController.begin({
      requestKey: requestKeyForCall(options),
      facts: options.recoveryFacts ?? { interventionIds: [] },
    });
    if (admission.kind === 'waiting') {
      throw new LLMRecoveryWaitRequiredError(admission.schedule, admission.factsAccepted);
    }
    let outcome: 'completed' | 'interrupted' | 'failed' = 'interrupted';
    let invocationError: unknown;
    let hasInvocationError = false;
    try {
      try {
        yield* this.invocationExecutor.stream({ options, admission });
        outcome = 'completed';
      } catch (error) {
        hasInvocationError = true;
        invocationError = error;
        outcome = isAbortError(error) ? 'interrupted' : 'failed';
        throw error;
      }
    } finally {
      try {
        await this.recoveryController.finish(admission.invocationId, admission.attemptId, outcome);
      } catch (finishError) {
        if (hasInvocationError) {
          throw new AggregateError([invocationError, finishError], 'LLM invocation and recovery finish both failed', { cause: invocationError });
        }
        throw finishError;
      }
    }
  }

  getProviderInfo(): { name: string; model: string; isFallback: boolean } {
    return this.invocationExecutor.getProviderInfo();
  }

  getFailureDisposition(error: unknown): LLMFailureDisposition {
    switch (classifyLLMError(error)) {
      case 'transient':
      case 'rate_limit':
      case 'quota':
      case 'permanent':
        return 'provider_recovery_scheduled';
      case 'context_exceeded':
        return 'context_exceeded';
      case 'abort':
        return 'abort';
      default:
        return 'unknown';
    }
  }

  prepareInputBudget(request: InputBudgetRequest): Promise<InputBudgetResult> {
    return this.invocationExecutor.prepareInputBudget(request);
  }

  async healthCheck(): Promise<boolean> {
    this.assertOpen();
    return this.invocationExecutor.healthCheck();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.probeController.close();
    await this.providerRuntime.close();
  }

  reloadConfig(newConfig: LLMOrchestratorConfig): void {
    this.assertOpen();
    const prepared = this.providerRuntime.prepareReload(newConfig);
    this.recoveryController.reloadProviderIdentities(
      prepared.providerIds,
      prepared.legacyProviderIds,
    );
    this.providerRuntime.commitReload(prepared);
    this.probeController.reload();
    this.emitLegacyConfigIgnored(newConfig);
  }
}

export function createLLMOrchestrator(config: InstanceConfig): LLMOrchestratorOwner {
  return new LLMOrchestratorImpl(config);
}
