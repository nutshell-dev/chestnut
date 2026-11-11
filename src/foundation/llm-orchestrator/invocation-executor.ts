/**
 * Single-invocation execution control flow.
 *
 * Provider recovery persistence remains behind the narrow ledger capability; this
 * module owns retry/failover/stream/hedge/idle-probe mechanics and invocation-local facts.
 */
import {
  LLMError,
  LLMEmptyResponseError,
  LLMRateLimitError,
  LLMStreamAbortedError,
  LLMTimeoutError,
  isAbortError,
  makeExternalAbortError,
  withCombinedAbortSignal,
  type LLMProvider,
  type LLMResponse,
  type ProviderStreamChunk,
} from '../llm-provider/index.js';
import {
  LLMAllProvidersFailedError,
  LLMCircuitBreakerOpenError,
  classifyLLMError,
  getQuotaResetAtMs,
  getRetryAfterSec,
  getUserActionHint,
  type LLMErrorClass,
  type LLMProviderFailure,
} from './errors.js';
import type {
  LLMCallOptions,
  LLMEventSink,
  LLMInstanceSnapshot,
  LLMOrchestratorConfig,
  LLMProviderHealthSnapshot,
  LLMProviderSnapshotEntry,
  LLMStreamChunk,
  InputBudgetRequest,
  InputBudgetResult,
} from './types.js';
import type { LLMProviderRecoveryState } from './instance-state.js';
import type { ProviderAdmission } from './provider-admission.js';
import type { ProviderRuntime } from './provider-runtime.js';
import type { RecoveryLedger, LLMRecoveryAdmission, RecoveryFailureInput } from './recovery-ledger.js';
import {
  DEFAULT_LLM_TIMEOUT_MS,
  LLM_PROBE_MAX_TOKENS,
} from './defaults.js';
import {
  classifyStreamDone,
  computeDynamicCallTimeoutMs,
  delay,
  estimatePromptTokens,
  isContentChunk,
  mergeSignals,
  wrapResponseAsStream,
} from './utils.js';
import { inputBudgetEvidence, observeInputBudget, timeoutInputTokens } from './input-budget.js';

export interface InvocationRecoveryLedger extends Pick<
  RecoveryLedger,
  'snapshot' | 'noteAttemptStarted' | 'attemptContext' | 'noteSuccess' | 'noteProviderSuccess' | 'noteFailure'
> {}

export interface InvocationExecutorDeps {
  runtime: ProviderRuntime;
  admission: ProviderAdmission;
  ledger: InvocationRecoveryLedger;
  events: LLMEventSink;
}

export interface InvocationInput {
  options: LLMCallOptions;
  admission: Extract<LLMRecoveryAdmission, { kind: 'admitted' }>;
}

export interface InvocationExecutor {
  call(input: InvocationInput): Promise<LLMResponse>;
  stream(input: InvocationInput): AsyncIterableIterator<LLMStreamChunk>;
  tryCallProvider(
    adapter: LLMProvider,
    breakerIndex: number,
    isFallback: boolean,
    options: LLMCallOptions,
    maxAttempts: number,
    estimatedInputTokens: number,
    generation: number,
    updateSelection?: boolean,
    correlation?: Pick<CallPathAudit, 'invocationId' | 'attemptId'>,
  ): Promise<LLMResponse>;
  minimalProbe(
    provider: LLMProvider,
    timeoutMs: number,
    userSignal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: 'network_timeout' | 'auth_or_model'; error: Error }>;
  computeAttemptDelayMs(attempt: number): number;
  snapshot(): LLMInstanceSnapshot;
  getProviderHealthSnapshot(): LLMProviderHealthSnapshot;
  getProviderInfo(): { name: string; model: string; isFallback: boolean };
  healthCheck(): Promise<boolean>;
  prepareInputBudget(request: InputBudgetRequest): Promise<InputBudgetResult>;
}

/**
 * Maximum exponential backoff delay (ms).
 *
 * Used as cap in `Math.min(retryDelayMs * 2^attempt, MAX_BACKOFF_MS)`
 * across LLM call() / stream() retry paths (line 170, 407).
 *
 * Value: 30_000 (30s) = empirical / 业界 HTTP retry cap 通常 20-60s 区间
 * （AWS SDK BaseRetryStrategy / GCP backoff cap 一般 32s）/ 平衡 server
 * recovery 等 vs user-perceived hang 上限.
 */
const MAX_BACKOFF_MS = 30_000;

/**
 * Default stream-idle probe timeout (ms).
 * Derivation: 5_000ms = 5s / 短 enough 不显著拖延 failover decision / 长 enough
 * 覆盖 typical TCP RTT + first byte（即使 cross-region）.
 */
const DEFAULT_STREAM_IDLE_PROBE_TIMEOUT_MS = 5_000;

/** 单次调用的局部限制（由 owner 的准入决定；不改变全局配置）。 */
interface CallLimits {
  maxAttempts: number;
  allowBreakerProbe: boolean;
  attemptId?: string;
}

/**
 * Phase 1968 Step B：一次 call/stream 调用的审计关联上下文。
 * invocationId 在 scoped 入口铸造；nextAttemptIndex 随实际执行（含跳过）单调递增，
 * 即审计事件 attemptIndex——顺序以实际执行为准，不从配置数组推断。
 */
interface CallPathAudit {
  invocationId: string;
  attemptId: string;
  winnerProviderId?: string;
  failures: LLMProviderFailure[];
  nextAttemptIndex: number;
  /** 调用入口捕获的配置代次；旧代次完成不得写回 last-success。 */
  generation: number;
  /** 已在候选失败发生处提交的失败条目；最终聚合只补交尚未记录的候选失败。 */
  recordedFailures: Set<LLMProviderFailure>;
}


export class LLMInvocationExecutor implements InvocationExecutor {
  private readonly runtime: ProviderRuntime;
  private readonly providerAdmission: ProviderAdmission;
  private readonly recoveryController: InvocationRecoveryLedger;
  private readonly events: LLMEventSink;
  private readonly failureObservedAtMs = new WeakMap<Error, number>();
  private currentStreamingProvider: { name: string; model: string; isFallback: boolean } | null = null;

  constructor(deps: InvocationExecutorDeps) {
    this.runtime = deps.runtime;
    this.providerAdmission = deps.admission;
    this.recoveryController = deps.ledger;
    this.events = deps.events;
  }

  private get primary(): LLMProvider { return this.runtime.primary(); }
  private get fallbacks(): readonly LLMProvider[] { return this.runtime.fallbacks(); }
  private get config(): LLMOrchestratorConfig { return this.runtime.config(); }
  private get providerIds(): readonly string[] { return this.runtime.providerIds(); }
  private get providerStates(): readonly LLMProviderRecoveryState[] { return this.recoveryController.snapshot().providers; }
  private get configGeneration(): number { return this.runtime.configGeneration(); }
  private get instanceId(): string { return this.recoveryController.snapshot().instanceId; }

  private isRecoveryBlocking(index: number, allowRecoveryProbe: boolean): boolean {
    if (allowRecoveryProbe) return false;
    const providerId = this.providerIds[index];
    const state = this.providerStates.find(provider => provider.providerId === providerId);
    return state !== undefined && !this.providerAdmission.canProbe(state, Date.now());
  }

  private recordProviderSuccess(
    providerIndex: number,
    adapter: LLMProvider,
    _isFallback: boolean,
    generation: number,
    updateSelection = true,
  ): void {
    if (generation !== this.configGeneration) return;
    this.recoveryController.noteProviderSuccess(
      this.identityAt(providerIndex, adapter.name),
      Date.now(),
      updateSelection,
    );
  }

  private recordRecoveryFailures(failures: readonly RecoveryFailureInput[]): void {
    this.recoveryController.noteFailure(failures);
  }

  private noteFailureObserved(error: Error): void {
    this.failureObservedAtMs.set(error, Date.now());
  }

  private async inputTokensFor(
    adapter: LLMProvider,
    options: LLMCallOptions,
    legacyEstimate: number,
  ): Promise<number> {
    const observation = await observeInputBudget(adapter, options, legacyEstimate);
    return timeoutInputTokens(observation);
  }

  private inputMeasurementObserver(
    adapter: LLMProvider,
    options: LLMCallOptions,
    correlation?: Pick<CallPathAudit, 'invocationId' | 'attemptId'>,
  ) {
    return (observation: import('../llm-provider/index.js').InputMeasurementObservation): void => {
      try { options.onInputMeasurement?.(observation); } catch { /* silent: observer contract is non-throwing */ }
      try {
        this.events.emit({
          type: 'input_measurement',
          ...(correlation?.invocationId !== undefined ? { invocationId: correlation.invocationId } : {}),
          ...(correlation?.attemptId !== undefined ? { attemptId: correlation.attemptId } : {}),
          provider: adapter.name,
          model: adapter.model,
          observation,
        });
      } catch {
        // silent: LLM event sinks are observational and must not change provider outcome.
      }
    };
  }

  async prepareInputBudget(request: InputBudgetRequest): Promise<InputBudgetResult> {
    const adapters = [this.primary, ...this.fallbacks];
    if (request.kind === 'failure') {
      const evidence = inputBudgetEvidence(request.error);
      if (evidence.length === 0) return { kind: 'unavailable', reason: 'missing_evidence' };
      for (const candidate of adapters) {
        for (const target of evidence) {
          if (candidate.name !== target.descriptor.provider || candidate.model !== target.descriptor.model) continue;
          try {
            const meter = await candidate.prepareInputMeter();
            return meter.descriptor.revision === target.descriptor.revision
              ? { kind: 'available', meter }
              : { kind: 'unavailable', reason: 'stale_revision' };
          } catch {
            // silent: stale provider evidence is returned as an explicit unavailable result.
            return { kind: 'unavailable', reason: 'stale_revision' };
          }
        }
      }
      return { kind: 'unavailable', reason: 'ambiguous_target' };
    }

    const selected = this.currentStreamingProvider
      ? adapters.find(candidate => candidate.name === this.currentStreamingProvider!.name && candidate.model === this.currentStreamingProvider!.model)
      : this.lastSuccessProvider
        ? adapters.find(candidate => candidate.name === this.lastSuccessProvider!.name && candidate.model === this.lastSuccessProvider!.model)
        : this.primary;
    if (!selected) return { kind: 'unavailable', reason: 'ambiguous_target' };
    try {
      return { kind: 'available', meter: await selected.prepareInputMeter() };
    } catch {
      // silent: missing provider capability is returned as an explicit unavailable result.
      return { kind: 'unavailable', reason: 'missing_evidence' };
    }
  }

  private toRecoveryFailures(
    failures: ReadonlyArray<LLMProviderFailure>,
    invocationId?: string,
    attemptId?: string,
  ): RecoveryFailureInput[] {
    return failures.map(failure => {
      const retryAfterSec = getRetryAfterSec(failure.error);
      const resetAtMs = getQuotaResetAtMs(failure.error);
      const localSkip = failure.localSkip === true || failure.error instanceof LLMCircuitBreakerOpenError;
      return {
        providerId: failure.providerId ?? this.providerIdOf(failure.provider),
        providerLabel: failure.provider,
        configRevision: this.configGeneration,
        ...(invocationId !== undefined ? { invocationId } : {}),
        ...(attemptId !== undefined ? { attemptId } : {}),
        ...(failure.attemptIndex !== undefined ? { attemptIndex: failure.attemptIndex } : {}),
        errorClass: classifyLLMError(failure.error),
        message: failure.error.message,
        ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
        ...(resetAtMs !== undefined ? { resetAtMs } : {}),
        occurredAtMs: this.failureObservedAtMs.get(failure.error) ?? Date.now(),
        ...(localSkip ? { localSkip } : {}),
      };
    });
  }

  private providerIdOf(providerName: string): string {
    const adapters = [this.primary, ...this.fallbacks];
    const index = adapters.findIndex(provider => provider.name === providerName);
    return index >= 0 ? this.identityAt(index, providerName) : `unknown:${providerName}`;
  }

  /**
   * phase 287 Step C: extract backoff formula to helper (M#1 共用基础设施单源)
   *
   * Exponential backoff with jitter, capped at MAX_BACKOFF_MS.
   * Formula: retryDelayMs * 2^attempt * (0.75 + random * 0.5) capped at MAX_BACKOFF_MS.
   */
  private computeBackoffMs(attempt: number): number {
    return Math.min(
      this.config.retryDelayMs * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5),
      MAX_BACKOFF_MS,
    );
  }

  /** 普通轮内重试退避；typed Retry-After 在调用路径直接切换候选，不在此等待。 */
  computeAttemptDelayMs(attempt: number): number {
    return this.computeBackoffMs(attempt);
  }

  snapshot(): LLMInstanceSnapshot {
    const adapters = [this.primary, ...this.fallbacks];
    const providers: LLMProviderSnapshotEntry[] = adapters.map((adapter, index) => {
      const providerId = this.providerIds[index];
      const state = this.providerStates.find(provider => provider.providerId === providerId);
      const waiting = state?.status === 'waiting';
      return {
        provider: adapter.name,
        isFallback: index > 0,
        breakerOpen: waiting,
        openCause: waiting ? state?.lastError?.class ?? 'unknown' : null,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        ...(waiting && state?.retryAt !== undefined ? { probeAllowedAtMs: state.retryAt } : {}),
      };
    });
    return { takenAtMs: Date.now(), providers };
  }

  getProviderHealthSnapshot(): LLMProviderHealthSnapshot {
    const snapshot = this.recoveryController.snapshot();
    return {
      revision: snapshot.revision,
      providers: this.providerIds.map(providerId => {
        const state = snapshot.providers.find(provider => provider.providerId === providerId);
        const errorClass = state?.status === 'waiting' ? state.lastError?.class ?? 'unknown' : undefined;
        return {
          providerId,
          healthKey: errorClass === undefined ? 'healthy' : `blocked:${errorClass}`,
        };
      }),
    };
  }

  getProviderInfo(): { name: string; model: string; isFallback: boolean } {
    if (this.currentStreamingProvider) return this.currentStreamingProvider;
    const latest = this.lastSuccessProvider;
    if (latest) return { name: latest.name, model: latest.model, isFallback: latest.isFallback };
    return { name: this.primary.name, model: this.primary.model, isFallback: false };
  }

  private get lastSuccessProvider(): {
    name: string;
    model: string;
    isFallback: boolean;
    providerId: string;
    generation: number;
    lastUsedAt: number;
    cacheValidUntil: number;
  } | null {
    let latest: LLMProviderRecoveryState | undefined;
    for (const provider of this.providerStates) {
      if (provider.lastSuccessAt === undefined || provider.cacheValidUntil === undefined) continue;
      if (latest === undefined || provider.lastSuccessAt > latest.lastSuccessAt!) latest = provider;
    }
    if (!latest) return null;
    const index = this.providerIds.indexOf(latest.providerId);
    const adapter = index >= 0 ? [this.primary, ...this.fallbacks][index] : undefined;
    if (!adapter || index < 0) return null;
    return {
      name: adapter.name,
      model: adapter.model,
      isFallback: index > 0,
      providerId: latest.providerId,
      generation: this.configGeneration,
      lastUsedAt: latest.lastSuccessAt!,
      cacheValidUntil: latest.cacheValidUntil!,
    };
  }

  async healthCheck(): Promise<boolean> {
    for (const adapter of [this.primary, ...this.fallbacks]) {
      const result = await this.minimalProbe(adapter, 10_000);
      if (result.ok) return true;
      this.events.emit({
        type: 'healthcheck_failed',
        provider: adapter.name,
        error: result.error.message,
      });
    }
    return false;
  }

  /**
   * Try a single provider with retries.
   * Returns LLMResponse on success, throws lastError when all retries exhausted.
   * Caller catches to proceed to next provider.
   */
  async tryCallProvider(
    adapter: LLMProvider,
    breakerIndex: number,
    isFallback: boolean,
    options: LLMCallOptions,
    maxAttempts: number,
    estimatedInputTokens: number,
    generation: number,
    updateSelection = true,
    correlation?: Pick<CallPathAudit, 'invocationId' | 'attemptId'>,
  ): Promise<LLMResponse> {
    let lastError: Error | undefined;
    const candidateInputTokens = await this.inputTokensFor(adapter, options, estimatedInputTokens);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (options.signal?.aborted) throw makeExternalAbortError(options.signal.reason);

      // Phase 1955 Step E：timeout 按输入规模动态计算（基础配置 + token 余量，封顶 10min）；
      // caller 的 hardTimeoutMs 仍是显式上限。
      const dynamicTimeoutMs = computeDynamicCallTimeoutMs(
        options.timeoutMs ?? this.baseTimeoutFor(adapter, isFallback),
        candidateInputTokens,
      );
      const hardTimeoutMs = options.hardTimeoutMs ?? dynamicTimeoutMs;
      let providerSignal: AbortSignal | undefined;
      let cleanupSignal: () => void = () => {};
      let hardSignal: AbortSignal | undefined;
      if (hardTimeoutMs) {
        const [handle, cleanup] = withCombinedAbortSignal(options.signal, hardTimeoutMs);
        providerSignal = handle.signal;
        cleanupSignal = cleanup;
        hardSignal = handle.signal;
      } else {
        providerSignal = options.signal;
      }
      const providerOptions: LLMCallOptions = {
        ...options,
        signal: providerSignal,
        hardTimeoutMs: undefined,
        streamIdleTimeoutMs: undefined,
        timeoutMs: options.timeoutMs ?? dynamicTimeoutMs,
        onInputMeasurement: this.inputMeasurementObserver(adapter, options, correlation),
      };

      try {
        if (updateSelection) this.currentStreamingProvider = { name: adapter.name, model: adapter.model, isFallback };
        const response = await adapter.call(providerOptions);
        cleanupSignal();
        if (updateSelection) this.recordProviderSuccess(breakerIndex, adapter, isFallback, generation);
        return response;
      } catch (error) {
        cleanupSignal();
        lastError = error as Error;
        this.noteFailureObserved(lastError);

        if (options.signal?.aborted) {
          throw makeExternalAbortError(options.signal.reason);
        }
        if (lastError.name === 'AbortError' && hardSignal?.aborted) throw lastError;
        if (lastError.name === 'AbortError' && !hardSignal?.aborted) throw lastError;

        if (classifyLLMError(lastError) === 'context_exceeded') {
          this.events.emit({ type: 'context_exceeded_throwthrough', provider: adapter.name });
          throw lastError;
        }

        this.events.emit({
          type: 'provider_attempt_failed',
          provider: adapter.name,
          attempt,
          maxAttempts,
          error: lastError.message,
          errorClass: classifyLLMError(lastError),
          userActionHint: getUserActionHint(lastError),
          ...(getRetryAfterSec(lastError) !== undefined ? { retryAfterSec: getRetryAfterSec(lastError) } : {}),
        });

        // 确定性错误（permanent / quota）立刻结束该 provider 本轮尝试，
        // 不消耗剩余轮内预算：重试同 provider 对确定性响应无意义（quota 时间窗
        // 恢复由 owner 的安排承担），仍继续考虑其余候选。
        const errClass = classifyLLMError(lastError);
        // typed Retry-After 是跨候选恢复下界，不是当前 provider 的轮内睡眠时长。
        if (getRetryAfterSec(lastError) !== undefined) break;
        if (errClass === 'permanent' || errClass === 'quota') {
          this.events.emit({ type: 'permanent_skip_retry', provider: adapter.name, attempt, errorClass: errClass });
          break;
        }

        if (attempt < maxAttempts - 1) {
          const backoffMs = this.computeAttemptDelayMs(attempt);
          this.events.emit({ type: 'retry_scheduled', provider: adapter.name, attempt, maxAttempts, backoffMs });
          await delay(backoffMs, options.signal);
        }
      }
    }

    // 候选失败由 noteCandidateFailure 统一写入 provider 恢复事实。
    this.events.emit({ type: 'provider_exhausted', provider: adapter.name, error: lastError!.message });
    throw lastError;
  }

  /**
   * Phase 1934 Z-C1：候选索引 → 身份指纹（与 providerIds 同源）。
   * 聚合错误的失败条目在产生处携带该指纹——显示名不是身份（同名不同
   * model/key/endpoint 是不同候选），记账/定位一律按指纹，不按显示名反查。
   */
  private identityAt(index: number, providerName: string): string {
    return this.providerIds[index] ?? `unknown:${providerName}`;
  }

  /** 一次 call/stream 调用的审计关联上下文（attemptIndex 单调递增）。 */
  private beginCallPath(kind: 'call' | 'stream', invocationId: string, attemptId: string): CallPathAudit {
    const adapters = [this.primary, ...this.fallbacks];
    const inv: CallPathAudit = {
      invocationId,
      attemptId,
      failures: [],
      nextAttemptIndex: 0,
      generation: this.configGeneration,
      recordedFailures: new Set<LLMProviderFailure>(),
    };
    this.events.emit({
      type: 'call_invocation_started',
      orchestratorInstance: this.instanceId,
      invocationId: inv.invocationId,
      attemptId: inv.attemptId,
      kind,
      configRevision: inv.generation,
      candidates: adapters.map((a, i) => ({
        name: a.name,
        providerId: this.providerIds[i] ?? `unknown:${a.name}`,
      })),
    });
    return inv;
  }

  /** 记录单个候选的终态（实际执行序），返回其 attemptIndex。 */
  private recordAttemptResult(
    inv: CallPathAudit,
    provider: string,
    providerId: string,
    outcome: 'success' | 'failure' | 'skipped' | 'discarded',
    detail: { errorClass?: LLMErrorClass; error?: string; reason?: string },
  ): number {
    const attemptIndex = inv.nextAttemptIndex++;
    this.events.emit({
      type: 'call_attempt_result',
      invocationId: inv.invocationId,
      ...(inv.attemptId !== undefined ? { attemptId: inv.attemptId } : {}),
      attemptIndex,
      provider,
      providerId,
      outcome,
      ...(detail.errorClass !== undefined ? { errorClass: detail.errorClass } : {}),
      ...(detail.error !== undefined ? { error: detail.error } : {}),
      ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
    });
    return attemptIndex;
  }

  /**
   * 候选失败：emit attempt 事件 + 推入聚合失败列表（携带同一 attemptIndex，供
   * LLMAllProvidersFailedError → recovery 证据对齐审计事件）。
   */
  private noteCandidateFailure(
    inv: CallPathAudit,
    failures: LLMProviderFailure[],
    provider: string,
    providerId: string,
    error: Error,
    errorClassOverride?: LLMErrorClass,
    recordImmediately = true,
  ): void {
    const attemptIndex = this.recordAttemptResult(inv, provider, providerId, 'failure', {
      errorClass: errorClassOverride ?? classifyLLMError(error),
      error: error.message,
    });
    const failure = { provider, error, providerId, attemptIndex };
    failures.push(failure);
    inv.failures.push(failure);
    if (recordImmediately && !inv.recordedFailures.has(failure)) {
      inv.recordedFailures.add(failure);
      this.recordRecoveryFailures(this.toRecoveryFailures([failure], inv.invocationId, inv.attemptId));
    }
  }

  /**
   * 候选跳过：emit skipped 事件（原因必录）；`aggregateError` 提供时同步推入聚合
   * 失败列表（breaker-open 条目保持既有 localSkip 恢复语义），未提供时只留审计事实
   * （如 sticky 重复候选跳过——不是失败）。
   */
  private noteCandidateSkipped(
    inv: CallPathAudit,
    failures: LLMProviderFailure[],
    provider: string,
    providerId: string,
    reason: string,
    aggregateError?: Error,
  ): void {
    const attemptIndex = this.recordAttemptResult(inv, provider, providerId, 'skipped', { reason });
    if (aggregateError) {
      const failure = { provider, error: aggregateError, providerId, attemptIndex, localSkip: true };
      failures.push(failure);
      inv.failures.push(failure);
    }
  }

  /** 候选成功 + 最终选择：两个事件都先于成功返回上层。 */
  private noteCandidateSuccess(
    inv: CallPathAudit,
    provider: string,
    providerId: string,
  ): void {
    inv.winnerProviderId = providerId;
    const attemptIndex = this.recordAttemptResult(inv, provider, providerId, 'success', {});
    this.events.emit({
      type: 'call_selection',
      invocationId: inv.invocationId,
      ...(inv.attemptId !== undefined ? { attemptId: inv.attemptId } : {}),
      outcome: 'selected',
      provider,
      providerId,
      attemptIndex,
    });
  }

  /** 全部候选用尽（含全跳过）：成功不可能，发布显式 exhausted 终态后由调用方抛出。 */
  private recordExhausted(inv: CallPathAudit): void {
    this.events.emit({
      type: 'call_selection',
      invocationId: inv.invocationId,
      ...(inv.attemptId !== undefined ? { attemptId: inv.attemptId } : {}),
      outcome: 'exhausted',
    });
  }

  async call({ options, admission }: InvocationInput): Promise<LLMResponse> {
    this.recoveryController.noteAttemptStarted(admission.invocationId);
    const limits = this.resolveCallLimits(admission.invocationId);
    const inv = this.beginCallPath('call', admission.invocationId, admission.attemptId);
    try {
      const response = await this._callCore(options, limits, inv);
      const unrecorded = inv.failures.filter(failure => !inv.recordedFailures.has(failure));
      if (unrecorded.length > 0) {
        this.recordRecoveryFailures(this.toRecoveryFailures(unrecorded, inv.invocationId, inv.attemptId));
      }
      if (inv.winnerProviderId === undefined) throw new Error('LLM call succeeded without a selected provider');
      this.recoveryController.noteSuccess(inv.invocationId, inv.winnerProviderId);
      return response;
    } catch (error) {
      if (error instanceof LLMAllProvidersFailedError) {
        const unrecorded = error.failures.filter(failure => !inv.recordedFailures.has(failure));
        if (unrecorded.length > 0) {
            this.recordRecoveryFailures(this.toRecoveryFailures(unrecorded, inv.invocationId, inv.attemptId));
        }
      }
      throw error;
    } finally {
      this.currentStreamingProvider = null;
    }
  }

  private resolveCallLimits(invocationId: string): CallLimits {
    const attempt = this.recoveryController.attemptContext(invocationId);
    return {
      maxAttempts: attempt.probeOnly ? 1 : this.config.maxAttempts,
      allowBreakerProbe: attempt.allowBreakerProbe,
      attemptId: attempt.attemptId,
    };
  }

  /** provider 配置的基础 timeout（动态 timeout 的起点）。 */
  private baseTimeoutFor(adapter: LLMProvider, isFallback: boolean): number {
    const config = isFallback
      ? (this.config.fallbacks ?? []).find(
        candidate => candidate.name === adapter.name && candidate.model === adapter.model,
      )
      : this.config.primary;
    return config?.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  }

  private async _callCore(options: LLMCallOptions, limits: CallLimits, inv: CallPathAudit): Promise<LLMResponse> {
    const allowBreakerProbe = limits.allowBreakerProbe;
    // Phase 1969：不做调用前预算 admission；估计值仅用于动态 timeout。
    const estimatedInputTokens = estimatePromptTokens(options);
    const decision = this.providerAdmission.choose({
      providerIds: this.providerIds,
      providers: this.providerStates,
      nowMs: Date.now(),
    });
    const failures: LLMProviderFailure[] = [];
    const attemptedProviderIds = new Set<string>();

    {
      // 统一 TTL 内保持上次成功的可用 fallback；到期或失败后从 primary 重评
      let stickyFb: LLMProvider | undefined;
      let stickyIdx = -1;
      if (decision.stickyProviderId !== undefined) {
        stickyIdx = this.fallbacks.findIndex((_, i) => this.providerIds[i + 1] === decision.stickyProviderId);
        stickyFb = stickyIdx >= 0 ? this.fallbacks[stickyIdx] : undefined;
        if (stickyFb && stickyIdx >= 0) {
          if (this.isRecoveryBlocking(stickyIdx + 1, allowBreakerProbe)) {
            this.noteCandidateSkipped(inv, failures, stickyFb.name, this.identityAt(stickyIdx + 1, stickyFb.name), 'provider_recovery_floor');
          } else {
            attemptedProviderIds.add(this.identityAt(stickyIdx + 1, stickyFb.name));
            try {
              const response = await this.tryCallProvider(stickyFb, stickyIdx + 1, true, options, limits.maxAttempts, estimatedInputTokens, inv.generation, true, inv);
              this.noteCandidateSuccess(inv, stickyFb.name, this.identityAt(stickyIdx + 1, stickyFb.name));
              return response;
            } catch (err) {
              // User abort is not a provider failure — propagate immediately
              if (options.signal?.aborted || isAbortError(err)) throw err;
              if (classifyLLMError(err) === 'context_exceeded') throw err;
              // silent: collect sticky fallback failure for aggregate LLMAllProvidersFailedError
              this.noteCandidateFailure(inv, failures, stickyFb.name, this.identityAt(stickyIdx + 1, stickyFb.name), err as Error);
            }
          }
        }
      }

      // Try primary
      let primaryFailed = false;
      if (this.isRecoveryBlocking(0, allowBreakerProbe)) {
        this.noteCandidateSkipped(inv, failures, this.primary.name, this.identityAt(0, this.primary.name), 'provider_recovery_floor');
      } else {
        attemptedProviderIds.add(this.identityAt(0, this.primary.name));
        try {
          const response = await this.tryCallProvider(this.primary, 0, false, options, limits.maxAttempts, estimatedInputTokens, inv.generation, true, inv);
          this.noteCandidateSuccess(inv, this.primary.name, this.identityAt(0, this.primary.name));
          return response;
        } catch (err) {
          // User abort is not a provider failure — propagate immediately
          if (options.signal?.aborted || isAbortError(err)) throw err;
          if (classifyLLMError(err) === 'context_exceeded') throw err;
          // silent: collect primary failure for aggregate LLMAllProvidersFailedError
          primaryFailed = true;
          this.noteCandidateFailure(inv, failures, this.primary.name, this.identityAt(0, this.primary.name), err as Error);
        }
      }

      // Primary exhausted/open — announce the fallback that is actually about
      // to be attempted. Emitting before filtering sticky/open fallbacks made
      // the forensic payload point at a provider that never ran.
      for (let i = 0; i < this.fallbacks.length; i++) {
        if (options.signal?.aborted) throw makeExternalAbortError(options.signal.reason);
        const providerId = this.identityAt(i + 1, this.fallbacks[i].name);
        if (attemptedProviderIds.has(providerId)) {
          // Phase 2064 Step B：sticky/前序候选已实际尝试过——重复身份只记跳过事实，不进聚合失败。
          this.noteCandidateSkipped(inv, failures, this.fallbacks[i].name, providerId, 'already_attempted');
          continue;
        }
        if (this.isRecoveryBlocking(i + 1, allowBreakerProbe)) {
          this.noteCandidateSkipped(inv, failures, this.fallbacks[i].name, providerId, 'provider_recovery_floor');
          continue;
        }
        attemptedProviderIds.add(providerId);
        try {
          this.events.emit({
            type: 'fallback_switched',
            from: this.primary.name,
            to: this.fallbacks[i].name,
            reason: primaryFailed ? 'primary_exhausted' : 'primary_breaker_open',
          });
          const response = await this.tryCallProvider(this.fallbacks[i], i + 1, true, options, limits.maxAttempts, estimatedInputTokens, inv.generation, true, inv);
          this.noteCandidateSuccess(inv, this.fallbacks[i].name, providerId);
          return response;
        } catch (err) {
          // User abort is not a provider failure — propagate immediately
          if (options.signal?.aborted || isAbortError(err)) throw err;
          if (classifyLLMError(err) === 'context_exceeded') throw err;
          // silent: collect fallback failure for aggregate LLMAllProvidersFailedError
          this.noteCandidateFailure(inv, failures, this.fallbacks[i].name, providerId, err as Error);
        }
      }

      this.recordExhausted(inv);
      throw new LLMAllProvidersFailedError(failures);
    }
  }

  async* stream({ options, admission }: InvocationInput): AsyncIterableIterator<LLMStreamChunk> {
    this.recoveryController.noteAttemptStarted(admission.invocationId);
    const limits = this.resolveCallLimits(admission.invocationId);
    const inv = this.beginCallPath('stream', admission.invocationId, admission.attemptId);
    try {
      yield* this._streamCore(options, limits, inv);
    } catch (error) {
      if (error instanceof LLMAllProvidersFailedError) {
        const unrecorded = error.failures.filter(failure => !inv.recordedFailures.has(failure));
        if (unrecorded.length > 0) {
            this.recordRecoveryFailures(this.toRecoveryFailures(unrecorded, inv.invocationId, inv.attemptId));
        }
      }
      throw error;
    }
    const unrecorded = inv.failures.filter(failure => !inv.recordedFailures.has(failure));
    if (unrecorded.length > 0) {
      this.recordRecoveryFailures(this.toRecoveryFailures(unrecorded, inv.invocationId, inv.attemptId));
    }
    if (inv.winnerProviderId === undefined) throw new Error('LLM stream succeeded without a selected provider');
    this.recoveryController.noteSuccess(inv.invocationId, inv.winnerProviderId);
  }

  private async* _streamCore(
    options: LLMCallOptions,
    limits: CallLimits,
    inv: CallPathAudit,
  ): AsyncIterableIterator<LLMStreamChunk> {
    // Phase 1969：不做调用前预算 admission；估计值仅用于动态 timeout。
    const estimatedInputTokens = estimatePromptTokens(options);
    // primary 的 transient 故障保留双轨 hedge；有效 fallback cache 期间不越过 cache。
    const decision = this.providerAdmission.choose({
      providerIds: this.providerIds,
      providers: this.providerStates,
      nowMs: Date.now(),
    });
    const primaryState = this.providerStates.find(provider => provider.providerId === this.providerIds[0]);
    const primaryWaiting = !decision.primaryAvailable;
    const hasValidFallbackCache = decision.stickyProviderId !== undefined;
    if (primaryWaiting && !hasValidFallbackCache && !limits.allowBreakerProbe
      && primaryState?.lastError?.class === 'transient' && this.fallbacks.length > 0 && this.primary.stream) {
      yield* this._streamHedge(options, inv);
      return;
    }

    // 有效 fallback cache 期间保持 sticky；到期后按配置顺序从 primary 重评。
    // 候选按位置构造，重复 identity 的不同 adapter 仍各自执行一次。
    const providers: Array<{ adapter: LLMProvider; breakerIndex: number; isFallback: boolean }> = [
      { adapter: this.primary, breakerIndex: 0, isFallback: false },
      ...this.fallbacks.map((adapter, index) => ({ adapter, breakerIndex: index + 1, isFallback: true })),
    ];
    if (decision.stickyProviderId !== undefined) {
      const stickyIndex = providers.findIndex(provider => this.providerIds[provider.breakerIndex] === decision.stickyProviderId);
      if (stickyIndex > 0) {
        const [sticky] = providers.splice(stickyIndex, 1);
        providers.unshift(sticky!);
      }
    }

    const failures: LLMProviderFailure[] = [];

    // contextExceededCount race 边界：single-threaded async loop / per-attempt increment / race 极小
    let contextExceededCount = 0;
    // phase 991 B.4: skipped (breaker-open) provider 不计入 totalAttempted 分母
    let skippedCount = 0;

    // phase 686: 跟踪上个失败 provider / 下个 provider 成功首 chunk 时 emit fallback_switched
    // call() 与 stream() 对称（call 在 line 262 已 emit、stream 路径之前缺、本 phase 补）
    let lastFailedProviderName: string | null = null;

    try {
    for (let pi = 0; pi < providers.length; pi++) {
      if (options.signal?.aborted) throw makeExternalAbortError(options.signal.reason);
      const { adapter, breakerIndex, isFallback } = providers[pi];

      if (!adapter.stream) {
        this.noteCandidateFailure(inv, failures, adapter.name, this.identityAt(breakerIndex, adapter.name), new Error('Provider does not support streaming'));
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: 'stream capability missing' };
        lastFailedProviderName = adapter.name;
        continue;
      }

      if (this.isRecoveryBlocking(breakerIndex, limits.allowBreakerProbe)) {
        skippedCount++;
        this.noteCandidateSkipped(inv, failures, adapter.name, this.identityAt(breakerIndex, adapter.name), 'provider_recovery_floor');
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: 'Provider recovery floor not reached' };
        lastFailedProviderName = adapter.name;
        continue;
      }

      let firstChunkAnnounced = false;  // phase 686: 本 provider 内 fallback_switched + currentStreamingProvider 只首 chunk 一次

      const candidateInputTokens = await this.inputTokensFor(adapter, options, estimatedInputTokens);


      // Retry loop (aligns with call())
      let success = false;
      let hasYielded = false;
      let receivedDone = false;
      let hasContent = false;  // owner predicate: text / thinking / tool-use content
      let lastError: Error | null = null;
      let contextExceeded = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let idleCtrl: AbortController | null = null;
      let cleanupSignal: (() => void) | undefined;
      for (let attempt = 0; attempt < limits.maxAttempts; attempt++) {
        hasYielded = false;
        receivedDone = false;
        hasContent = false;
        idleTimer = undefined;
        idleCtrl = null;
        cleanupSignal = undefined;
        try {
          const idleMs = options.streamIdleTimeoutMs;
          idleCtrl = idleMs ? new AbortController() : null;
          const resetIdleTimer = () => {
            if (!idleCtrl || !idleMs) return;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => idleCtrl!.abort(), idleMs);
          };

          const merged = mergeSignals(options.signal, idleCtrl?.signal);
          cleanupSignal = merged.cleanup;
          // Phase 1955 Step E：stream timeout 按输入规模动态计算；持续有 chunk 的
          // 长请求由 idle timeout 判定，不按固定 wall-clock 截断。
          const providerOptions: LLMCallOptions = {
            ...options,
            signal: merged.signal,
            hardTimeoutMs: undefined,
            streamIdleTimeoutMs: undefined,
            timeoutMs: options.timeoutMs ?? computeDynamicCallTimeoutMs(
              this.baseTimeoutFor(adapter, isFallback),
              candidateInputTokens,
            ),
            onInputMeasurement: this.inputMeasurementObserver(adapter, options, inv),
          };

          let pendingDone: ProviderStreamChunk | null = null;
          resetIdleTimer();
          for await (const chunk of adapter.stream(providerOptions)) {
            resetIdleTimer();
            // phase 686: 首 chunk yield 前 emit fallback_switched + set currentStreamingProvider
            if (!firstChunkAnnounced) {
              firstChunkAnnounced = true;
              if (lastFailedProviderName !== null && lastFailedProviderName !== adapter.name) {
                this.events.emit({
                  type: 'fallback_switched',
                  from: lastFailedProviderName,
                  to: adapter.name,
                  reason: 'failover_succeeded',
                });
                lastFailedProviderName = null;
              }
              this.currentStreamingProvider = { name: adapter.name, model: adapter.model, isFallback: providers[pi].isFallback };
            }
            hasYielded = true;
            if (isContentChunk(chunk)) hasContent = true;
            if (chunk.type === 'done') {
              receivedDone = true;
              if (classifyStreamDone(chunk) === 'context_exceeded') {
                contextExceeded = true;
                this.events.emit({ type: 'context_exceeded_failover', provider: adapter.name, stopReason: chunk.stopReason! });
                yield {
                  type: 'reset',
                  provider: adapter.name,
                };
                break; // exit inner stream loop early
              }
              // Defer yielding done until we know the stream actually carried content.
              // A done-only stream will be treated as an empty response and failed over.
              pendingDone = chunk;
              continue;
            }
            yield chunk;
          }

          if (contextExceeded) {
            contextExceededCount++;
            // Phase 1968 Step B：context-exceeded 候选不进聚合 failures（既有语义），
            // 但 attempt path 必须有终态——记录 failure（errorClass=context_exceeded）。
            this.recordAttemptResult(inv, adapter.name, this.identityAt(breakerIndex, adapter.name), 'failure', {
              errorClass: 'context_exceeded',
              error: 'stream done with context_exceeded stopReason',
            });
            lastFailedProviderName = adapter.name;  // phase 686
            break; // exit retry loop → outer loop continues to next provider
          }

          if (pendingDone && hasContent) {
            yield pendingDone;
          }
          success = true;
          break; // Success, exit retry loop
        } catch (error) {
          const err = error as Error;
          lastError = err;
          this.noteFailureObserved(err);
          const isUserAbort = options.signal?.aborted;
          const isIdleTimeout = idleCtrl?.signal.aborted && !isUserAbort;

          if (isUserAbort) throw makeExternalAbortError(options.signal?.reason);

          if (isIdleTimeout) {
            // ⚓4 ε ratified by phase 628 user binary: probe-then-decide
            // (per design/modules/l2_llm_orchestrator.md §B.stream-idle-failover-vs-retry-symmetry / phase 637 兑现)
            // - probe success → idle 是 transient lull / retry same provider stream
            // - probe failure (network/timeout) → failover next provider
            // - probe auth/model 错 → throw user-facing reconfigure
            const probeTimeoutMs = options.streamIdleProbeTimeoutMs ?? DEFAULT_STREAM_IDLE_PROBE_TIMEOUT_MS;
            this.events.emit({
              type: 'stream_idle_probe_attempted',
              provider: adapter.name,
              timeoutMs: probeTimeoutMs,
            });
            const probe = await this.minimalProbe(adapter, probeTimeoutMs, options.signal);
            if (options.signal?.aborted) {
              // user abort overrides probe result — stop immediately instead of failover/retry
              throw makeExternalAbortError(options.signal.reason);
            }
            if (probe.ok) {
              if (options.signal?.aborted) {
                throw makeExternalAbortError(options.signal.reason);
              }
              this.events.emit({
                type: 'stream_idle_probe_succeeded',
                provider: adapter.name,
              });
              if (hasYielded) {
                // partial output already yielded → reset before retry
                this.events.emit({ type: 'stream_reset', provider: adapter.name, error: 'idle_timeout_probe_retry' });
                yield {
                  type: 'reset',
                  provider: adapter.name,
                };
              }
              continue; // retry same provider stream within retry loop（复用 maxAttempts budget）
            }
            if (probe.reason === 'auth_or_model') {
              if (options.signal?.aborted) {
                throw makeExternalAbortError(options.signal.reason);
              }
              if (hasYielded) {
                this.events.emit({ type: 'stream_reset', provider: adapter.name, error: 'idle_timeout_probe_failed' });
                yield { type: 'reset', provider: adapter.name, timeoutMs: options.streamIdleTimeoutMs };
              }
              // probe auth/model 错 = 用户配置问题 / throw 给 caller decide
              throw probe.error;
            }
            if (hasYielded) {
              this.events.emit({ type: 'stream_reset', provider: adapter.name, error: 'idle_timeout_probe_failed' });
              yield { type: 'reset', provider: adapter.name, timeoutMs: options.streamIdleTimeoutMs };
            }
            // probe network/timeout → failover next provider（既有 idle_failover 路径）
            this.events.emit({
              type: 'idle_failover_triggered',
              provider: adapter.name,
              ms: options.streamIdleTimeoutMs!,
            });
            lastError = new LLMTimeoutError(adapter.name, options.streamIdleTimeoutMs!);
            lastFailedProviderName = adapter.name;  // phase 686
            break; // exit retry loop → outer loop continues to next provider
          }

          // Provider self-thrown AbortError when no signal fired
          if (err.name === 'AbortError') throw err;

          // phase 690: stream 路径 context-exceeded（400 at handshake）→ 直接向上抛
          // 不 failover、不 retry、不进 stream_reset partial-state 路径（context-exceeded 必 0 chunks yielded）
          if (classifyLLMError(err) === 'context_exceeded') {
            this.events.emit({ type: 'context_exceeded_throwthrough', provider: adapter.name });
            throw err;
          }

          // Mid-stream error: signal caller to discard partial state, then failover to next provider
          if (hasYielded) {
            this.events.emit({ type: 'stream_reset', provider: adapter.name, error: err.message });
            yield {
              type: 'reset',
              provider: adapter.name,
              ...(err instanceof LLMTimeoutError ? { timeoutMs: err.timeoutMs } : {}),
            };
            lastFailedProviderName = adapter.name;  // phase 686
            break; // exit retry loop → outer loop continues to next provider
          }

          // Phase 1268 Step C: stream 与 call 对称 — 握手前每次 provider 调用失败
          // 即 emit 真实 attempt/maxAttempts/retryAfterSec；不再有结束后硬编码 0 的补发。
          this.events.emit({
            type: 'provider_attempt_failed',
            provider: adapter.name,
            attempt,
            maxAttempts: limits.maxAttempts,
            error: err.message,
            errorClass: classifyLLMError(err),
            userActionHint: getUserActionHint(err),
            ...(getRetryAfterSec(err) !== undefined ? { retryAfterSec: getRetryAfterSec(err) } : {}),
          });

          // 确定性错误（permanent / quota）立刻结束该 provider 本轮尝试，与 call 路径
          // 使用同一策略：不重试、继续考虑其余候选（quota 时间窗恢复归 owner 安排）。
          const handshakeErrClass = classifyLLMError(err);
          if (getRetryAfterSec(err) !== undefined) {
            lastError = err;
            lastFailedProviderName = adapter.name;
            break;
          }
          if (handshakeErrClass === 'permanent' || handshakeErrClass === 'quota') {
            this.events.emit({ type: 'permanent_skip_retry', provider: adapter.name, attempt, errorClass: handshakeErrClass });
            lastError = err;
            lastFailedProviderName = adapter.name;
            break; // exit retry loop → outer loop continues to next provider
          }

          // Don't wait after the last attempt
          if (attempt < limits.maxAttempts - 1) {
            const backoffMs = this.computeAttemptDelayMs(attempt);
            this.events.emit({ type: 'retry_scheduled', provider: adapter.name, attempt, maxAttempts: limits.maxAttempts, backoffMs });
            await delay(backoffMs, options.signal);
          }
        } finally {
          // Phase 2045 Step C：每 attempt 统一在 finally 清理 idle timer 与 merged signal
          // listener——成功、异常、break/continue 与 consumer 在内容 yield 后提前 return
          // （generator return 必经 finally）都恰好执行一次；正常/catch 路径不再各自清理。
          clearTimeout(idleTimer);
          cleanupSignal?.();
        }
      }

      if (success && receivedDone && hasContent) {
        // breaker 与 lastSuccess 在同一候选中提交。
        this.recordProviderSuccess(breakerIndex, adapter, providers[pi].isFallback, inv.generation);
        // Phase 1968 Step B：selection 先于成功返回上层（本 return 即 generator 成功出口）。
        this.noteCandidateSuccess(inv, adapter.name, this.identityAt(breakerIndex, adapter.name));
        return; // Success, exit generator
      }

      if (success && receivedDone && !hasContent) {
        // Empty done-only response: stream emitted done without any text/tool content.
        // Treat as a failure and failover to the next provider.
        this.events.emit({ type: 'stream_reset', provider: adapter.name, error: 'empty done-only response' });
        yield {
          type: 'reset',
          provider: adapter.name,
        };
        // phase 1275: breaker_opened emit 由 CircuitBreaker.onTransition 回调
        // 独占（实计数）；此处手动检查与回调判定同一状态转移、重复 emit。
        const err = new LLMEmptyResponseError(adapter.name);
        this.events.emit({
          type: 'provider_attempt_failed',
          provider: adapter.name,
          attempt: 0,
          maxAttempts: 1,  // done-only 单次语义失败，不消耗 retry 预算
          error: err.message,
          errorClass: 'unknown',
          userActionHint: null,
        });
        this.noteCandidateFailure(inv, failures, adapter.name, this.identityAt(breakerIndex, adapter.name), err, 'unknown');
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: err.message };
        lastFailedProviderName = adapter.name;  // phase 686
      }

      if (success && hasYielded && !receivedDone) {
        // Stream ended cleanly but never emitted a done chunk — truncated/interrupted stream.
        // Signal caller to discard partial state, then failover to next provider.
        this.events.emit({ type: 'stream_reset', provider: adapter.name, error: 'stream ended without done chunk' });
        yield {
          type: 'reset',
          provider: adapter.name,
        };
        const err = new LLMStreamAbortedError(adapter.name, 'stream ended without done chunk');
        this.events.emit({
          type: 'provider_attempt_failed',
          provider: adapter.name,
          attempt: 0,
          maxAttempts: 1,  // 截断流单次语义失败，不消耗 retry 预算
          error: err.message,
          errorClass: classifyLLMError(err),
          userActionHint: getUserActionHint(err),
        });
        this.noteCandidateFailure(inv, failures, adapter.name, this.identityAt(breakerIndex, adapter.name), err);
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: err.message };
        lastFailedProviderName = adapter.name;  // phase 686
      }

      if (success && !hasYielded) {
        // ⚓5 α default ratified by phase 628 user binary (default accepted):
        // 0-chunk → onFailure (conservative miss-detect / D5 redundant defense)
        // (per design/modules/l2_llm_orchestrator.md §B.stream-zero-chunk-breaker-sensitivity / phase 637 兑现)
        // Stream completed normally but produced nothing — treat as failure
        // phase 815 P1.34: 显式 pass 'unknown' / 防 half-open probe 失败时 lastFailureClass 保 stale prior class
        // （`if (errClass)` 守卫在 CircuitBreaker.onFailure 不 update lastFailureClass when errClass undefined / 修触发点不动 CB）
        const err = new LLMEmptyResponseError(adapter.name);
        this.events.emit({
          type: 'provider_attempt_failed',
          provider: adapter.name,
          attempt: 0,
          maxAttempts: 1,  // 0-chunk 单次语义失败，不消耗 retry 预算
          error: err.message,
          errorClass: 'unknown',
          userActionHint: null,
        });
        this.noteCandidateFailure(inv, failures, adapter.name, this.identityAt(breakerIndex, adapter.name), err, 'unknown');
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: err.message };
        lastFailedProviderName = adapter.name;  // phase 686
        // Continue to next provider
      } else if (!success && !contextExceeded) {
        // Circuit breaker: record failure（breaker_opened emit 由 onTransition 回调独占）
        // Phase 1268 Step C: 删除 provider 结束后硬编码 attempt: 0 的第二个
        // provider_attempt_failed —— 握手前逐 attempt emit（retry loop catch）已覆盖，
        // provider_failed stream chunk 保留为对调用方的不同语义信号。
        const err = lastError ?? new LLMStreamAbortedError(adapter.name, 'no error captured');
        this.noteCandidateFailure(inv, failures, adapter.name, this.identityAt(breakerIndex, adapter.name), err);
        yield { type: 'provider_failed' as const, provider: adapter.name, model: adapter.model, error: err.message };
        lastFailedProviderName = adapter.name;  // phase 686
        // Continue to next provider
      }
    }
    } finally {
      // phase 686: generator 出口（success return / throw / consumer abort）一定清 currentStreamingProvider
      // getProviderInfo 回落到 lastSuccessProvider（既有语义）
      this.currentStreamingProvider = null;
    }

    // All providers failed
    const totalProviders = providers.length;
    // phase 991 B.4: 减 skipped 让 user-actionable context-exceeded message 在 1+ skipped 时仍能触发
    const totalAttempted = totalProviders - skippedCount;
    if (contextExceededCount > 0 && contextExceededCount === totalAttempted) {
      this.events.emit({
        type: 'all_providers_context_exceeded',
        totalAttempted,
        skippedCount,
      });
      this.recordExhausted(inv);
      throw new LLMError(
        `All ${totalAttempted} providers exhausted with context_window_exceeded. ` +
        `Reduce system prompt, tool definitions, or conversation history.`,
        { totalAttempted, skippedCount },
      );
    }

    this.recordExhausted(inv);
    throw new LLMAllProvidersFailedError(failures);
  }

  /**
   * Minimal probe: single non-stream call with explicit timeout.
   * Distinguishes transient network/timeout errors from auth/model config issues.
   */
  async minimalProbe(
    provider: LLMProvider,
    timeoutMs: number,
    userSignal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: 'network_timeout' | 'auth_or_model'; error: Error }> {
    const probeCtrl = new AbortController();
    const probeTimer = setTimeout(() => probeCtrl.abort(), timeoutMs);
    const merged = mergeSignals(userSignal, probeCtrl.signal);
    const signal = merged.signal ?? probeCtrl.signal;
    try {
      await provider.call({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: LLM_PROBE_MAX_TOKENS,
        signal,
      });
      return { ok: true };
    } catch (err) {
      const e = err as Error;
      const errorClass = classifyLLMError(e);
      // abort/typed 真实故障可 failover；auth/model/unknown 保持配置错误出口。
      if (
        probeCtrl.signal.aborted ||
        signal.aborted ||
        e.name === 'AbortError' ||
        e instanceof LLMRateLimitError ||
        errorClass === 'transient' ||
        errorClass === 'rate_limit' ||
        errorClass === 'quota'
      ) {
        return { ok: false, reason: 'network_timeout', error: e };
      }
      // 其他（含 auth/model 配置错）→ 非 transient 用户配置问题
      return { ok: false, reason: 'auth_or_model', error: e };
    } finally {
      clearTimeout(probeTimer);
      merged.cleanup();
    }
  }

  /** Context-done is a request-local terminal failure after hedge A has produced content. */
  private async* _failHedgePrimaryContext(
    inv: CallPathAudit,
    stopReason: string,
  ): AsyncIterableIterator<LLMStreamChunk> {
    this.events.emit({ type: 'context_exceeded_failover', provider: this.primary.name, stopReason });
    this.recordAttemptResult(inv, this.primary.name, this.identityAt(0, this.primary.name), 'failure', {
      errorClass: 'context_exceeded',
      error: 'stream done with context_exceeded stopReason',
    });
    yield { type: 'reset', provider: this.primary.name };
    this.recordExhausted(inv);
    throw new LLMError(
      `All 1 providers exhausted with context_window_exceeded. ` +
      `Reduce system prompt, tool definitions, or conversation history.`,
      { totalAttempted: 1, skippedCount: 0 },
    );
  }

  /**
   * 2-track hedge on breaker open (phase 737).
   * Track A: primary stream — wait for first content chunk (real recovery evidence).
   * Track B: fallback chain sequential call() — first success wins.
   * Winner-takes-all via Promise.race; loser aborted to avoid resource waste.
   */
  private async* _streamHedge(options: LLMCallOptions, inv: CallPathAudit): AsyncIterableIterator<LLMStreamChunk> {
    const fallbackNames = this.fallbacks.map(f => f.name);
    this.events.emit({
      type: 'hedge_started',
      primary: this.primary.name,
      fallbackChain: fallbackNames,
      triggerErrorClass: 'transient',
    });

    const primaryCtrl = new AbortController();
    const trackBCtrl = new AbortController();

    const primaryMerged = mergeSignals(options.signal, primaryCtrl.signal);
    const trackBMergedBase = mergeSignals(options.signal, trackBCtrl.signal);
    const cleanupSignals = () => { primaryMerged.cleanup(); trackBMergedBase.cleanup(); };

    // Track A: primary.stream() iter, wait for first content chunk
    const primaryProviderOpts: LLMCallOptions = {
      ...options,
      signal: primaryMerged.signal,
      hardTimeoutMs: undefined,
      streamIdleTimeoutMs: undefined,
    };
    const primaryIter = this.primary.stream!(primaryProviderOpts);
    let primaryClosed = false;
    const closePrimary = async () => {
      if (primaryClosed) return;
      primaryClosed = true;
      try { await primaryIter.return?.(); } catch { /* silent: 已关闭/重复清理不改变原结果 */ }
    };

    try {
      type AResult =
        | { winner: 'A'; chunk: ProviderStreamChunk }
        | { winner: 'A-error'; error: Error };

      const trackAPromise: Promise<AResult> = (async () => {
        try {
          // Manual next() to avoid for-await...return triggering iterator.return()
          // which would terminate the generator and prevent post-race drain.
          while (true) {
            const { done, value: chunk } = await primaryIter.next();
            if (done) break;
            if (isContentChunk(chunk)) return { winner: 'A', chunk };
            // skip metadata chunks (done/reset/thinking_signature/etc.)
          }
          const error = new LLMStreamAbortedError(this.primary.name, 'stream ended without content chunk');
          this.noteFailureObserved(error);
          return { winner: 'A-error', error };
        } catch (e) {
          const error = e as Error;
          this.noteFailureObserved(error);
          return { winner: 'A-error', error };
        }
      })();

      // Track B: fallback chain sequential call()
      type BResult =
        | { winner: 'B'; provider: LLMProvider; providerIndex: number; response: LLMResponse }
        | { winner: 'B-error'; failures: LLMProviderFailure[] };

      const trackBPromise: Promise<BResult> = (async () => {
        const failures: LLMProviderFailure[] = [];
        for (let i = 0; i < this.fallbacks.length; i++) {
          if (trackBCtrl.signal.aborted) return { winner: 'B-error', failures };
          const fb = this.fallbacks[i];
          if (this.isRecoveryBlocking(i + 1, false)) {
            this.noteCandidateSkipped(inv, failures, fb.name, this.identityAt(i + 1, fb.name), 'provider_recovery_floor');
            continue;
          }
          const fbMerged = mergeSignals(options.signal, trackBCtrl.signal);
          const fbOpts: LLMCallOptions = {
            ...options,
            signal: fbMerged.signal,
            hardTimeoutMs: undefined,
            streamIdleTimeoutMs: undefined,
          };
          try {
            const response = await fb.call(fbOpts);
            fbMerged.cleanup();
            this.recordProviderSuccess(i + 1, fb, true, inv.generation);
            return { winner: 'B', provider: fb, providerIndex: i, response };
          } catch (err) {
            fbMerged.cleanup();
            // User abort takes priority over any provider-internal signal
            if (options.signal?.aborted) {
              throw makeExternalAbortError(options.signal.reason);
            }
            if (trackBCtrl.signal.aborted) return { winner: 'B-error', failures };
            const e = err as Error;
            this.noteFailureObserved(e);
            const errClass = classifyLLMError(e);
            this.events.emit({
              type: 'provider_attempt_failed',
              provider: fb.name,
              attempt: 0,
              maxAttempts: 1,  // hedge track B 每 provider 单次 call，不走 retry 预算
              error: e.message,
              errorClass: errClass,
              userActionHint: getUserActionHint(e),
              ...(getRetryAfterSec(e) !== undefined ? { retryAfterSec: getRetryAfterSec(e) } : {}),
            });
            // Hedge 旁路失败先共享同一 failure 对象到 B 结果与 invocation；由最终
            // 成功/聚合失败统一提交，避免 A 的请求局部终态把已放弃旁路写成共享故障。
            this.noteCandidateFailure(inv, failures, fb.name, this.identityAt(i + 1, fb.name), e, errClass, false);
          }
        }
        return { winner: 'B-error', failures };
      })();

      // Race
      const winner = await Promise.race([trackAPromise, trackBPromise]);

      // A 胜（first content chunk）
      if (winner.winner === 'A') {
        trackBCtrl.abort();
        yield winner.chunk;
        let receivedDone = false;
        let contextDoneStopReason: string | undefined;
        let drainError: Error | undefined;
        try {
          // phase 991 B.2: drain loop user-abort early-exit guard
          for await (const chunk of primaryIter) {
            if (options.signal?.aborted) {
              throw makeExternalAbortError(options.signal.reason);
            }
            if (chunk.type === 'done') {
              if (classifyStreamDone(chunk) === 'context_exceeded') {
                contextDoneStopReason = chunk.stopReason;
                break;
              }
              receivedDone = true;
            }
            yield chunk;
          }
        } catch (err) {
          this.noteFailureObserved(err as Error);
          // User abort is not a provider failure — don't trip breaker or emit stream_reset
          if (options.signal?.aborted) {
            throw makeExternalAbortError(options.signal.reason);
          }
          // Phase 1968 Step B：hedge primary 首 chunk 后失败也是 attempt 终态。
          this.noteCandidateFailure(inv, [], this.primary.name, this.identityAt(0, this.primary.name), err as Error);
          this.events.emit({
            type: 'hedge_primary_post_first_chunk_failure',
            provider: this.primary.name,
            error: err as Error,
          });
          // phase 991 B.6: emit stream_reset + yield reset chunk mirror non-hedge line 442-450
          // caller 收 reset signal 知 discard partial state、与 non-hedge path 对称 invariant
          this.events.emit({ type: 'stream_reset', provider: this.primary.name, error: (err as Error).message });
          yield {
            type: 'reset',
            provider: this.primary.name,
            ...(err instanceof LLMTimeoutError ? { timeoutMs: err.timeoutMs } : {}),
          };
          drainError = err as Error;
        } finally {
          // phase 1374 sub-2: explicit cleanup instead of relying on GC / for-await auto-close
          await closePrimary();
          cleanupSignals();
        }
        if (contextDoneStopReason) {
          yield* this._failHedgePrimaryContext(inv, contextDoneStopReason);
          return;
        }
        if (!receivedDone && !drainError) {
          // Clean EOF without done → truncated stream, treat as provider failure
          this.events.emit({ type: 'stream_reset', provider: this.primary.name, error: 'hedge primary stream ended without done chunk' });
          const error = new LLMStreamAbortedError(this.primary.name, 'stream ended without done chunk');
          this.noteFailureObserved(error);
          this.noteCandidateFailure(inv, [], this.primary.name, this.identityAt(0, this.primary.name), error, 'transient');
          yield { type: 'reset', provider: this.primary.name };
          yield { type: 'provider_failed', provider: this.primary.name, model: this.primary.model, error: 'stream ended without done chunk' };
          throw error;
        }
        if (drainError) throw drainError;
        if (receivedDone) {
          this.recordProviderSuccess(0, this.primary, false, inv.generation);
          this.events.emit({ type: 'hedge_primary_recovered', provider: this.primary.name });
          // Phase 1968 Step B：selection 先于成功返回（hedge A 轨恢复成功）。
          this.noteCandidateSuccess(inv, this.primary.name, this.identityAt(0, this.primary.name));
        }
        return;
      }

      // B 胜（fallback call success）
      if (winner.winner === 'B') {
        primaryCtrl.abort();
        const aResult = await trackAPromise;

        if (aResult.winner === 'A') {
          // 3 态 race outcome: A 实际 produced content chunk 但 B race 先 settled (rare race window)
          // NEW event explicit observability、不合成假 'primary stream cancelled' Error
          // Phase 1968 Step B：A 已产出内容但未成为最终选择——记 discarded，不伪造成功/失败。
          this.recordAttemptResult(inv, this.primary.name, this.identityAt(0, this.primary.name), 'discarded', {
            reason: 'race_lost_after_first_chunk',
          });
          this.events.emit({
            type: 'hedge_primary_succeeded_after_race_lost',
            primaryProvider: this.primary.name,
            winnerProvider: winner.provider.name,
          });
          this.events.emit({
            type: 'hedge_fallback_committed',
            winnerProvider: winner.provider.name,
            primaryProvider: this.primary.name,
            primaryError: 'A succeeded but race lost (commit fallback for low latency)',
            primaryErrorClass: 'unknown', // A succeeded、no real error; 'unknown' enum value 不误导 (LLMErrorClass 无 'none')
            cacheCreationInputTokens: winner.response.usage?.cache_creation_input_tokens ?? undefined,
            cacheReadInputTokens: winner.response.usage?.cache_read_input_tokens ?? undefined,
          });
        } else {
          // A-error (含 AbortError from primaryCtrl.abort propagated to iterator)
          if (options.signal?.aborted) {
            throw makeExternalAbortError(options.signal.reason);
          }
          const primaryErr = aResult.error;
          const primaryErrClass = classifyLLMError(primaryErr);
          this.noteCandidateFailure(inv, [], this.primary.name, this.identityAt(0, this.primary.name), primaryErr, primaryErrClass);
          this.events.emit({
            type: 'hedge_fallback_committed',
            winnerProvider: winner.provider.name,
            primaryProvider: this.primary.name,
            primaryError: primaryErr.message,
            primaryErrorClass: primaryErrClass,
            cacheCreationInputTokens: winner.response.usage?.cache_creation_input_tokens ?? undefined,
            cacheReadInputTokens: winner.response.usage?.cache_read_input_tokens ?? undefined,
          });
        }

        // Phase 1968 Step B：B 轨成功被 commit——selection 先于 yield* 响应。
        this.noteCandidateSuccess(inv, winner.provider.name, this.identityAt(winner.providerIndex + 1, winner.provider.name));
        // NEW: drain primary generator (mirror L821 double-fail template)
        await closePrimary();
        this.events.emit({ type: 'race_loser_cleaned', provider: this.primary.name, reason: 'hedge_trackB_won' });
        cleanupSignals();
        yield* wrapResponseAsStream(winner.response);
        return;
      }

      // A-error 胜（A 早失败）→ 等 B
      if (winner.winner === 'A-error') {
        if (classifyLLMError(winner.error) === 'context_exceeded') {
          trackBCtrl.abort();
          await trackBPromise;
          this.recordAttemptResult(inv, this.primary.name, this.identityAt(0, this.primary.name), 'failure', {
            errorClass: 'context_exceeded',
            error: winner.error.message,
          });
          await closePrimary();
          cleanupSignals();
          throw winner.error;
        }
        const bResult = await trackBPromise;
        if (options.signal?.aborted) {
          throw makeExternalAbortError(options.signal.reason);
        }
        if (bResult.winner === 'B') {
          primaryCtrl.abort();
          // Phase 1968 Step B：A 早失败终态 + B 成功 selection 均先于响应返回。
          this.noteCandidateFailure(inv, [], this.primary.name, this.identityAt(0, this.primary.name), winner.error);
          this.events.emit({
            type: 'hedge_fallback_committed',
            winnerProvider: bResult.provider.name,
            primaryProvider: this.primary.name,
            primaryError: winner.error.message,
            primaryErrorClass: classifyLLMError(winner.error),
            cacheCreationInputTokens: bResult.response.usage?.cache_creation_input_tokens ?? undefined,
            cacheReadInputTokens: bResult.response.usage?.cache_read_input_tokens ?? undefined,
          });
          this.noteCandidateSuccess(inv, bResult.provider.name, this.identityAt(bResult.providerIndex + 1, bResult.provider.name));
          cleanupSignals();
          yield* wrapResponseAsStream(bResult.response);
          return;
        }
        // 双失败
        // phase 991 B.3: primary breaker accounting mirror line 715 single-fail
        if (options.signal?.aborted) {
          throw makeExternalAbortError(options.signal.reason);
        }
        await closePrimary();
        cleanupSignals();
        // Phase 1968 Step B：双失败终态——A 失败 attempt（B 侧各候选已在 track B 循环记录）。
        const aFailures: LLMProviderFailure[] = [];
        this.noteCandidateFailure(inv, aFailures, this.primary.name, this.identityAt(0, this.primary.name), winner.error);
        this.recordExhausted(inv);
        throw new LLMAllProvidersFailedError([...aFailures, ...bResult.failures]);
      }

      // B-error 胜（B 全失败）→ 等 A
      const aResult = await trackAPromise;
      if (aResult.winner === 'A') {
        trackBCtrl.abort();
        yield aResult.chunk;
        let receivedDone = false;
        let contextDoneStopReason: string | undefined;
        let drainError: Error | undefined;
        try {
          // phase 991 B.2: drain loop user-abort early-exit guard
          for await (const chunk of primaryIter) {
            if (options.signal?.aborted) {
              throw makeExternalAbortError(options.signal.reason);
            }
            if (chunk.type === 'done') {
              if (classifyStreamDone(chunk) === 'context_exceeded') {
                contextDoneStopReason = chunk.stopReason;
                break;
              }
              receivedDone = true;
            }
            yield chunk;
          }
        } catch (err) {
          this.noteFailureObserved(err as Error);
          // User abort is not a provider failure — don't trip breaker or emit stream_reset
          if (options.signal?.aborted) {
            throw makeExternalAbortError(options.signal.reason);
          }
          // Phase 1968 Step B：hedge primary 首 chunk 后失败也是 attempt 终态。
          this.noteCandidateFailure(inv, [], this.primary.name, this.identityAt(0, this.primary.name), err as Error);
          this.events.emit({
            type: 'hedge_primary_post_first_chunk_failure',
            provider: this.primary.name,
            error: err as Error,
          });
          this.events.emit({ type: 'stream_reset', provider: this.primary.name, error: (err as Error).message });
          yield {
            type: 'reset',
            provider: this.primary.name,
            ...(err instanceof LLMTimeoutError ? { timeoutMs: err.timeoutMs } : {}),
          };
          drainError = err as Error;
        } finally {
          cleanupSignals();
        }
        if (contextDoneStopReason) {
          yield* this._failHedgePrimaryContext(inv, contextDoneStopReason);
          return;
        }
        if (!receivedDone && !drainError) {
          // Clean EOF without done → truncated stream, treat as provider failure
          this.events.emit({ type: 'stream_reset', provider: this.primary.name, error: 'hedge primary stream ended without done chunk' });
          const error = new LLMStreamAbortedError(this.primary.name, 'stream ended without done chunk');
          this.noteFailureObserved(error);
          this.noteCandidateFailure(inv, [], this.primary.name, this.identityAt(0, this.primary.name), error, 'transient');
          yield { type: 'reset', provider: this.primary.name };
          yield { type: 'provider_failed', provider: this.primary.name, model: this.primary.model, error: 'stream ended without done chunk' };
          throw error;
        }
        if (drainError) throw drainError;
        if (receivedDone) {
          this.recordProviderSuccess(0, this.primary, false, inv.generation);
          this.events.emit({ type: 'hedge_primary_recovered', provider: this.primary.name });
          // Phase 1968 Step B：selection 先于成功返回（B 全败后 A 恢复成功）。
          this.noteCandidateSuccess(inv, this.primary.name, this.identityAt(0, this.primary.name));
        }
        return;
      }
      // 双失败
      // phase 991 B.3: primary breaker accounting mirror line 715 single-fail
      if (options.signal?.aborted) {
        throw makeExternalAbortError(options.signal.reason);
      }
      if (classifyLLMError(aResult.error) === 'context_exceeded') {
        this.recordAttemptResult(inv, this.primary.name, this.identityAt(0, this.primary.name), 'failure', {
          errorClass: 'context_exceeded',
          error: aResult.error.message,
        });
        await closePrimary();
        cleanupSignals();
        throw aResult.error;
      }
      await closePrimary();
      cleanupSignals();
      // Phase 1968 Step B：双失败终态——A 失败 attempt（B 侧各候选已在 track B 循环记录）。
      const aFailures: LLMProviderFailure[] = [];
      this.noteCandidateFailure(inv, aFailures, this.primary.name, this.identityAt(0, this.primary.name), aResult.error);
      this.recordExhausted(inv);
      throw new LLMAllProvidersFailedError([...aFailures, ...winner.failures]);
    } finally {
      await closePrimary();
      cleanupSignals();
    }
  }
}
