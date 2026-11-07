/**
 * LLM Service - Main implementation with failover and retry
 * 
 * Implements LLMOrchestrator interface
 * - Retry with exponential backoff
 * - Failover to fallback provider
 */


import { type LLMProvider, type LLMResponse, isAbortError } from '../llm-provider/index.js';
import {
  classifyLLMError,
  getRetryAfterSec,
  getQuotaResetAtMs,
  type LLMProviderFailure,
} from './errors.js';

import type {
  LLMOrchestratorConfig,
  LLMCallOptions,
  LLMEventSink,
  LLMInstanceSnapshot,
  LLMInstanceLifecycle,
  LLMOrchestrator,
  LLMProbeResult,
  LLMProviderSnapshotEntry,
  LLMProviderHealthSnapshot,
  LLMRuntimeCapability,
  ProbeTargetReason,
  LLMFailureDisposition,
  LLMStreamChunk } from './types.js';
import {
  LLMRecoveryControllerImpl,
  requestKeyForCall,
  type LLMOrchestratorOwner,
  type RecoveryFailureInput,
  type SharedRecoveryDecision,
} from './recovery.js';
import type {
  LLMInstanceRecoveryState,
  LLMInstanceStateV3,
  LLMProviderRecoveryState,
} from './instance-state.js';
import { LLMCircuitBreakerOpenError, LLMOrchestratorClosedError, LLMRecoveryWaitRequiredError } from './errors.js';
import { LLMInvocationExecutor, type InvocationExecutor } from './invocation-executor.js';
import { LLMProviderRuntime } from './provider-runtime.js';
import { formatErr } from '../node-utils/index.js';  // Phase 1933 Step B: probe 结果错误摘要
import { legacyProviderIdentity, providerIdentity } from './provider-identity.js';
import { LLMProviderAdmission, type ProviderAdmission } from './provider-admission.js';
import {
  LLMInstanceStateStore,
  type InstanceStateCandidate,
} from './instance-state-store.js';

import { LLM_PROVIDER_SELECTION_TTL_MS } from './defaults.js';  // Phase 1933 Step F / 1934 Step C / 1955 Step E / 1979 常量

interface LastSuccessProvider {
  name: string;
  model: string;
  isFallback: boolean;
  providerId: string;
  generation: number;
  lastUsedAt: number;
  cacheValidUntil: number;
}

type InstanceConfig = LLMOrchestratorConfig & { lifecycle: LLMInstanceLifecycle };

/**
 * LLM Service implementation
 */
export class LLMOrchestratorImpl implements LLMOrchestrator, LLMOrchestratorOwner, LLMRuntimeCapability {
  private primary: LLMProvider;
  private fallbacks: LLMProvider[];
  private config: LLMOrchestratorConfig;

  /**
   * Phase 1826: 与 [primary, ...fallbacks] 同序的不可逆 provider 身份指纹。
   * 恢复安排按身份记账（换 key/endpoint/model 即视为不同候选），不暴露明文凭据。
   */
  private providerIds: string[] = [];
  /** 与 providerIds 同序的旧算法身份，仅供既有恢复事实兼容重键。 */
  private legacyProviderIds: string[] = [];

  private providerStates: LLMProviderRecoveryState[] = [];
  private readonly providerAdmission: ProviderAdmission = new LLMProviderAdmission();
  private readonly instanceStateStore: LLMInstanceStateStore;

  /** 展示与 sticky 选择均从每 provider 的成功时间派生，不维护第二份选择事实。 */
  private get lastSuccessProvider(): LastSuccessProvider | null {
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

  // phase 686: 「正在流的 provider」/ stream 中首 chunk yield 时设、generator 出口（finally）清
  // 修 getProviderInfo 滞后一轮的 bug（failover 转换轮内本字段反映本轮 provider、非上一轮）
  private currentStreamingProvider: {
    name: string;
    model: string;
    isFallback: boolean;
  } | null = null;

  private events: LLMEventSink;
  private readonly lifecycle: LLMInstanceLifecycle;
  private get instanceRevision(): number {
    return this.instanceStateStore.revision;
  }
  private instanceId: string;
  private recoveryState: LLMInstanceRecoveryState;
  private readonly recoveryController: LLMRecoveryControllerImpl;
  private readonly providerRuntime: LLMProviderRuntime;
  private readonly invocationExecutor: InvocationExecutor;

  /** 白盒兼容引用；真实 cache owner 是 ProviderRuntime。 */
  get sdkClientCache(): Map<string, LLMProvider> {
    return this.providerRuntime.clientCache;
  }

  /**
   * Phase 1933 Step B：实例内进行中的独立探针（单一调度）。
   * 并发/重入 probe() 调用去重为同一次真实探测；finally 清空。
   * 纯内存字段：探针调度不跨进程，禁止文件/socket/全局目录作为状态通道。
   */
  private inflightProbe: Promise<LLMProbeResult> | null = null;
  /** Phase 2056：实例内公平游标；重启从 0 重建，持久健康/恢复下界仍由 V2 继承。 */
  private probeCursor = 0;

  /**
   * Phase 1933 Step F：进程内探针唤醒调度（实例内能力，不跨进程）。
   * - readyListeners：探针成功后的就绪信号订阅者；close 后不再投递。
   * - scheduleTimer/scheduleGeneration：单一调度槽——重复 scheduleProbe 替换既有
   *   安排（generation 单调递增，过期 timer 触发时比对丢弃）；close 幂等取消。
   * - closed：close 后 scheduleProbe 为 no-op、进行中的探针完成后不投递。
   */
  private readyListeners = new Set<() => void>();
  private scheduleTimer?: ReturnType<typeof setTimeout>;
  private scheduleGeneration = 0;
  private closed = false;

  /** provider 抛错的真实观察时刻；Retry-After 下界不得被后续聚合/持久化延迟抬高。 */
  private failureObservedAtMs = new WeakMap<Error, number>();
  /** 配置代次：reloadConfig 单调 +1；旧代次 probe 结果不得清新状态/投递唤醒。 */
  private configGeneration = 0;
  /** 在途探针的取消句柄（close 时 abort；finally 清空）。 */
  private probeAbort: AbortController | null = null;

  constructor(config: InstanceConfig) {
    this.config = config;
    this.events = config.events;
    this.lifecycle = config.lifecycle;
    this.providerRuntime = new LLMProviderRuntime({
      ...config,
      events: { emit: event => this.events?.emit(event) },
    });
    this.primary = this.providerRuntime.primary();
    this.fallbacks = [...this.providerRuntime.fallbacks()];
    this.recomputeProviderIdentities(config);

    this.instanceStateStore = new LLMInstanceStateStore({
      ...this.lifecycle,
      providerIds: this.providerIds,
      legacyProviderIds: this.legacyProviderIds,
      events: { emit: event => this.events?.emit(event) },
    });
    const publishProjection = (state: LLMInstanceStateV3): void => {
      this.instanceId = state.instanceId;
      this.recoveryState = state.recovery;
      this.providerStates = state.providers.map(provider => ({ ...provider }));
    };
    const persisted = this.instanceStateStore.load(publishProjection);
    // 直接赋值同时满足构造期 definite assignment；load 回调保证 degraded 事件前投影已发布。
    this.instanceId = persisted.instanceId;
    this.recoveryState = persisted.recovery;
    this.providerStates = persisted.providers.map(provider => ({ ...provider }));
    this.recoveryController = new LLMRecoveryControllerImpl({
      instanceId: this.instanceId,
      providerIds: this.providerIds,
      legacyProviderIds: this.legacyProviderIds,
      admission: this.providerAdmission,
      read: () => ({
        recovery: this.recoveryState,
        revision: this.instanceRevision,
        providers: this.providerStates,
      }),
      emit: event => this.events.emit(event),
      commit: (recovery, context, providers) => {
        const committed = this.commitInstanceCandidate({
          providers: [...(providers ?? this.providerStates)],
          recovery,
        }, context);
        if (!committed) throw new Error(`LLM instance state persistence failed during ${context}`);
        return this.instanceRevision;
      },
    });
    this.invocationExecutor = new LLMInvocationExecutor({
      runtime: {
        primary: () => this.primary,
        fallbacks: () => this.fallbacks,
        config: () => this.config,
        providerIds: () => this.providerIds,
        providerStates: () => this.providerStates,
        configGeneration: () => this.configGeneration,
        instanceId: () => this.instanceId,
      },
      admission: this.providerAdmission,
      ledger: this.recoveryController,
      host: {
        isRecoveryBlocking: (index, allowRecoveryProbe) => this.isRecoveryBlocking(index, allowRecoveryProbe),
        setCurrentStreamingProvider: provider => { this.currentStreamingProvider = provider; },
        recordProviderSuccess: (index, adapter, isFallback, generation, updateSelection) => {
          this.recordProviderSuccess(index, adapter, isFallback, generation, updateSelection);
        },
        recordRecoveryFailures: failures => { this.recordRecoveryFailures(failures); },
        toRecoveryFailures: (failures, invocationId, attemptId) => {
          return this.toRecoveryFailures(failures, invocationId, attemptId);
        },
        noteFailureObserved: error => { this.failureObservedAtMs.set(error, Date.now()); },
      },
      events: { emit: event => this.events?.emit(event) },
    });
    // 恢复探测由实例自主维持；不依赖 ATS 是否正处于等待。
    this.scheduleProbe(this.nextAutonomousProbeAt());
  }

  /** 白盒兼容薄委托；唯一持久化与 revision owner 是 InstanceStateStore。 */
  private commitInstanceCandidate(
    candidate: InstanceStateCandidate,
    context: string,
    providerIds: readonly string[] = this.providerIds,
    force = false,
  ): boolean {
    const result = this.instanceStateStore.commit(context, candidate, {
      providerIds,
      force,
      publish: () => {
        this.providerStates = candidate.providers;
        this.recoveryState = candidate.recovery;
      },
    });
    return result.kind !== 'failed';
  }

  private recordProviderSuccess(
    providerIndex: number,
    adapter: LLMProvider,
    _isFallback: boolean,
    generation: number,
    updateSelection = true,
  ): void {
    if (generation !== this.configGeneration) return;
    const providerId = this.identityAt(providerIndex, adapter.name);
    const nowMs = Date.now();
    const providers = this.providerStates.map(provider => ({ ...provider }));
    const index = providers.findIndex(provider => provider.providerId === providerId);
    const previous: LLMProviderRecoveryState = index >= 0
      ? providers[index]!
      : { providerId, status: 'available' };
    const next = this.providerAdmission.recordSuccess(previous, { nowMs, updateSelection });
    if (index >= 0) providers[index] = next;
    else providers.push(next);
    const committed = this.commitInstanceCandidate({
      providers,
      recovery: this.recoveryState,
    }, updateSelection ? 'provider_success' : 'probe_provider_health_clear');
    if (!committed) throw new Error('LLM instance state persistence failed during provider success');
  }

  /** 白盒兼容薄委托；真实 retry/timeout/abort 控制流归 InvocationExecutor。 */
  private async _tryCallProvider(
    adapter: LLMProvider,
    breakerIndex: number,
    isFallback: boolean,
    options: LLMCallOptions,
    maxAttempts: number,
    estimatedInputTokens: number,
    generation: number,
    updateSelection = true,
  ): Promise<LLMResponse> {
    return this.invocationExecutor.tryCallProvider(
      adapter, breakerIndex, isFallback, options, maxAttempts,
      estimatedInputTokens, generation, updateSelection,
    );
  }

  /** 白盒兼容薄委托；退避公式归 InvocationExecutor。 */
  computeAttemptDelayMs(attempt: number): number {
    return this.invocationExecutor.computeAttemptDelayMs(attempt);
  }

  /** Phase 1826: 重算 provider 身份（构造与 reloadConfig 同步调用，保持与 providers 同序）。 */
  private recomputeProviderIdentities(config: LLMOrchestratorConfig): void {
    const all = [config.primary, ...(config.fallbacks ?? [])];
    this.providerIds = all.map(providerIdentity);
    this.legacyProviderIds = all.map(legacyProviderIdentity);
  }

  /** 当前完整身份，与 [primary, ...fallbacks] 同序；调用方不能修改内部数组。 */
  getProviderIdentities(): readonly string[] {
    return [...this.providerIds];
  }

  /** 旧算法身份，仅供 recovery 对既有事实做同修订兼容重键。 */
  getLegacyProviderIdentities(): readonly string[] {
    return [...this.legacyProviderIds];
  }

  /** 把 provider 名映射回身份指纹；未知 provider 用带前缀的稳定字面（不猜身份）。 */
  private providerIdOf(providerName: string): string {
    const adapters = [this.primary, ...this.fallbacks];
    const index = adapters.findIndex((p) => p.name === providerName);
    return index >= 0 && this.providerIds[index] !== undefined
      ? this.providerIds[index]
      : `unknown:${providerName}`;
  }

  /**
   * Phase 1934 Z-C1：候选索引 → 身份指纹（与 providerIds 同源）。
   * 聚合错误的失败条目在产生处携带该指纹——显示名不是身份（同名不同
   * model/key/endpoint 是不同候选），记账/定位一律按指纹，不按显示名反查。
   */
  private identityAt(index: number, providerName: string): string {
    return this.providerIds[index] ?? `unknown:${providerName}`;
  }

  // ---------------------------------------------------------------------------
  // Phase 1968 Step B：provider 调用路径审计（LLM-CALL-SUCCESS-PROVENANCE-NOT-AUDITABLE）
  //
  // 纪律：
  // - invocationId 在 _callScoped/_streamScoped 入口铸造，贯穿候选循环、hedge 与聚合失败；
  // - attemptIndex 是实际执行序列号（含跳过），不由配置数组下标推断；
  // - selection 事件在成功返回上层之前同步发布（sink emit 同步），审计写降级由 sink
  //   显式标记（llm_call_audit_write_failed），本层不吞；
  // - abort/context throwthrough/预检拒绝不产生 selection 终态（无候选被选择），重启后
  //   不得凭缺失的 selection 伪造成功；
  // - 只记录不可逆身份指纹（providerIds），不落明文 API key。
  // ---------------------------------------------------------------------------

  /**
   * Phase 1933 Step B：实例级故障快照——进程内共享状态的只读视图。
   *
   * 只读纪律：breaker.isOpen() 有副作用（open 超时后会转移 half-open），
   * 快照禁止触发状态转移，故 open 判定用纯查询 probeAllowedAtMs()（仅
   * state==='open' 时非 null）与 getOpenCause()。不发事件、不写盘。
   */
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
    return {
      revision: this.instanceRevision,
      providers: this.providerIds.map(providerId => {
        const state = this.providerStates.find(provider => provider.providerId === providerId);
        const errorClass = state?.status === 'waiting' ? state.lastError?.class ?? 'unknown' : undefined;
        return {
          providerId,
          healthKey: errorClass === undefined ? 'healthy' : `blocked:${errorClass}`,
        };
      }),
    };
  }

  /**
   * Phase 1933 Step B / 1934 Step C：独立探针。
   *
   * - 实例内单一调度：并发/重入调用返回同一 promise（inflightProbe，finally 清空）。
   * - 每次指定一个候选（禁止 fallback 掩盖目标失败）：优先验证已到点的故障候选，
   *   其次任一故障候选，无故障记录时默认 primary（健康检查语义）。
   * - 真实探测：直接走 _tryCallProvider（不经过 _callCore 的 breaker 拦截判定），
   *   成功/失败自然按既有语义记账 breaker；失败另记共享故障（推进下界）。
   * - 探针请求无工具/用户上下文；预算取目标配置合法 maxTokens（缺省省略，取消
   *   硬编码 1）；带目标配置 timeoutMs 的有界 timeout；close 取消在途。
   * - 不重试、不级联 fallback；结果经返回值表达（不抛业务错）。
   */
  probe(): Promise<LLMProbeResult> {
    this.assertOpen();
    if (this.inflightProbe) return this.inflightProbe;
    this.inflightProbe = this._runProbe().finally(() => {
      this.inflightProbe = null;
    });
    return this.inflightProbe;
  }

  /** 探针目标选择：故障下界先过滤，再从实例游标公平轮转；未到期候选绝不真实调用。 */
  private pickProbeTarget(): {
    adapter: LLMProvider;
    breakerIndex: number;
    isFallback: boolean;
    identity: string;
    reason: ProbeTargetReason;
    nextCursor: number;
  } | undefined {
    const adapters = [this.primary, ...this.fallbacks];
    const entries = adapters.map((adapter, index) => ({
      adapter,
      breakerIndex: index,
      isFallback: index > 0,
      identity: this.providerIds[index] ?? `unknown:${adapter.name}`,
      failed: this.hasProbeFailure(index),
    }));
    if (!entries.some(entry => entry.failed)) {
      return { ...entries[0]!, reason: 'default_primary', nextCursor: 1 % entries.length };
    }
    const nowMs = Date.now();
    const start = this.probeCursor % entries.length;
    const ordered = [...entries.slice(start), ...entries.slice(0, start)];
    const primary = entries[0]!;
    const candidate = primary.failed && this.canProbeProvider(0, nowMs)
      ? primary
      : ordered.find(entry => entry.failed && this.canProbeProvider(entry.breakerIndex, nowMs))
        ?? ordered.find(entry => this.canProbeProvider(entry.breakerIndex, nowMs));
    if (!candidate) return undefined;
    return {
      ...candidate,
      reason: candidate.failed ? 'expired_failure' : 'fairness_rotation',
      nextCursor: (candidate.breakerIndex + 1) % entries.length,
    };
  }

  private hasProbeFailure(index: number): boolean {
    const providerId = this.providerIds[index];
    return this.providerStates.some(provider => provider.providerId === providerId && provider.status === 'waiting');
  }

  private probeFloorMs(index: number): number {
    const providerId = this.providerIds[index];
    const state = this.providerStates.find(provider => provider.providerId === providerId);
    if (state?.status !== 'waiting') return 0;
    return state.retryAt ?? Number.POSITIVE_INFINITY;
  }

  private canProbeProvider(index: number, nowMs: number): boolean {
    const providerId = this.providerIds[index];
    const state = this.providerStates.find(provider => provider.providerId === providerId);
    return state === undefined || this.providerAdmission.canProbe(state, nowMs);
  }

  /** 白盒兼容薄委托；候选恢复下界由 ProviderAdmission 统一判定。 */
  private isRecoveryBlocking(index: number, allowRecoveryProbe: boolean): boolean {
    if (allowRecoveryProbe) return false;
    return !this.canProbeProvider(index, Date.now());
  }

  /** 探针的真实执行体（单一实例；并发去重由 probe() 保证）。 */
  private async _runProbe(): Promise<LLMProbeResult> {
    const probedAtMs = Date.now();
    const generation = this.configGeneration;
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
    const probeInvocationId = `probe:${this.instanceId}:${probedAtMs}:${target.breakerIndex}`;
    const failureObservedAt = this.providerStates.find(provider => provider.providerId === target.identity)?.lastError?.at;
    const targetConfig = target.breakerIndex === 0
      ? this.config.primary
      : this.config.fallbacks?.[target.breakerIndex - 1];
    this.probeAbort = new AbortController();
    const probeOptions: LLMCallOptions = {
      messages: [{ role: 'user', content: 'ping' }],
      signal: this.probeAbort.signal,
      ...(targetConfig?.maxTokens !== undefined ? { maxTokens: targetConfig.maxTokens } : {}),
      ...(targetConfig?.timeoutMs !== undefined ? { hardTimeoutMs: targetConfig.timeoutMs } : {}),
    };
    try {
      // Probe 保持配置的有界 timeout（不按输入规模扩展）：显式探测要求快速了结。
      await this._tryCallProvider(target.adapter, target.breakerIndex, target.isFallback, probeOptions, 1, 0, generation, false);
      // 旧配置或更新失败事实之后到达的 probe 成功不得覆盖新状态。
      if (generation === this.configGeneration) {
        const currentFailureAt = this.providerStates.find(provider => provider.providerId === target.identity)?.lastError?.at;
        if (currentFailureAt === failureObservedAt) {
          this.recordProviderSuccess(target.breakerIndex, target.adapter, target.isFallback, generation, false);
        }
      }
      return { ok: true, provider: target.adapter.name, probedAtMs };
    } catch (err) {
      const e = err as Error;
      // 与真实候选失败共用同一 provider 恢复事实；close/旧配置代次的迟到失败不记账。
      if (!this.closed && generation === this.configGeneration) {
        const failure = { provider: target.adapter.name, error: e, providerId: target.identity };
          const errorClass = classifyLLMError(e);
        if (errorClass !== 'context_exceeded' && errorClass !== 'abort') {
          this.recordRecoveryFailures(this.toRecoveryFailures(
            [failure],
            probeInvocationId,
            `${probeInvocationId}:attempt`,
          ));
          this.scheduleProbe(this.nextAutonomousProbeAt());
        }
      }
      return {
        ok: false,
        provider: target.adapter.name,
        probedAtMs,
        error: formatErr(e),
        errorClass: classifyLLMError(e),
        ...(getRetryAfterSec(e) !== undefined ? { retryAfterSec: getRetryAfterSec(e) } : {}),
      };
    } finally {
      this.probeAbort = null;
    }
  }

  /**
   * Phase 1933 Step F：订阅实例内恢复就绪信号；返回退订函数。close 后不再投递。
   */
  subscribeReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => { this.readyListeners.delete(listener); };
  }

  /**
   * Phase 1933 Step F / 1934 Step C：安排在 atMs（ms epoch）发起一次独立探针；
   * 重复调用替换既有安排（取最新）。
   * - owner 下界钳制：decision 为 at 时生效时刻取 max(atMs, nextProbeAt)，caller
   *   传过去时间不能绕过 typed Retry-After / breaker 弹回下界；on_change（无可用
   *   时间下界）不定时轮询，既有安排一并取消。
   * - 到点后由 owner 判据驱动：未到下界重排；到点依次验证候选（每探针一个候选），
   *   探针结果体现在共享故障记录上——任何允许候选验证成功（decision 转 ready）
   *   后投递就绪信号（listener 异常不扩散）；仍阻断则按 owner 下界自动安排下一次。
   * - ready 后仍按剩余故障下界/统一 TTL 自主续探；close 后调用为 no-op，
   *   旧配置代次的探针结果不投递、不重排。
   * 探针不直接执行任务——唤醒动作由 ready 信号的消费方（ATS）承担，调度本身不依赖 ATS。
   */
  private nextAutonomousProbeAt(): number {
    const nowMs = Date.now();
    let nextFailureAt: number | undefined;
    for (let i = 0; i < this.providerIds.length; i++) {
      if (!this.hasProbeFailure(i)) continue;
      const floorMs = this.probeFloorMs(i);
      if (!Number.isFinite(floorMs)) continue;
      nextFailureAt = nextFailureAt === undefined ? floorMs : Math.min(nextFailureAt, floorMs);
    }
    return nextFailureAt ?? nowMs + LLM_PROVIDER_SELECTION_TTL_MS;
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
      const fireGeneration = this.configGeneration;
      const fireDecision = this.getSharedRecoveryDecision();
      if (fireDecision.kind === 'at' && fireDecision.nextProbeAt > Date.now()) {
        // 下界被后续故障推后：重排到 owner 下界（不到点不空探）
        this.scheduleProbe(fireDecision.nextProbeAt);
        return;
      }
      // 与进行中探针去重合并：发布/重排由首发 continuation 承担（防重复唤醒）。
      const mergedIntoInflight = this.inflightProbe !== null;
      void this.probe().then(() => {
        if (this.closed || mergedIntoInflight || fireGeneration !== this.configGeneration) return;
        const d = this.getSharedRecoveryDecision();
        if (d.kind === 'ready') {
          for (const listener of this.readyListeners) {
            try { listener(); } catch { /* silent: 唤醒投递 fail-soft——单个 listener 失败不扩散，探针状态不受影响 */ }
          }
          // ready 不是调度终点：继续验证其他故障候选；全部健康时按统一 TTL 复检。
          this.scheduleProbe(this.nextAutonomousProbeAt());
        } else if (d.kind === 'at') {
          this.scheduleProbe(d.nextProbeAt);
        }
      }).catch(error => {
        this.events.emit({ type: 'instance_state_write_failed', context: 'probe_timer', reason: formatErr(error) });
        if (!this.closed && fireGeneration === this.configGeneration) {
          this.scheduleProbe(this.nextAutonomousProbeAt());
        }
      });
    }, Math.max(0, effectiveAtMs - Date.now()));
  }

  /**
   * 共享恢复判据的唯一解释点（F-11/F-02）。
   * 任一候选无共享故障记录 → ready（按既有 fallback 顺序即可服务）；全部候选被
   * 阻断时，全部 provider 故障（含 permanent）的最早下界为 nextProbeAt（min 语义——
   * 调度器依次验证候选，任一允许候选成功后即 ready）。
   * 只读判定：不触发 breaker 状态转移（probeAllowedAtMs 纯查询），不发事件、不写盘。
   */
  getSharedRecoveryDecision(): SharedRecoveryDecision {
    let minAtMs: number | undefined;
    for (let i = 0; i < this.providerIds.length; i++) {
      if (!this.hasProbeFailure(i)) return { kind: 'ready' };
      const floorMs = this.probeFloorMs(i);
      if (!Number.isFinite(floorMs)) continue;
      minAtMs = minAtMs === undefined ? floorMs : Math.min(minAtMs, floorMs);
    }
    return minAtMs === undefined
      ? { kind: 'on_change' }
      : { kind: 'at', nextProbeAt: minAtMs };
  }

  private recordRecoveryFailures(failures: readonly RecoveryFailureInput[]): void {
    if (failures.length === 0) return;
    this.recoveryController.noteFailure(failures);
    if (!this.closed) this.scheduleProbe(this.nextAutonomousProbeAt());
  }

  /** Phase 1826: 把最终失败转成 owner 策略输入（含 typed Retry-After 与本地跳过标记）。 */
  private toRecoveryFailures(
    failures: ReadonlyArray<LLMProviderFailure>,
    invocationId?: string,
    attemptId?: string,
  ): RecoveryFailureInput[] {
    return failures.map((f) => {
      const retryAfterSec = getRetryAfterSec(f.error);
      const resetAtMs = getQuotaResetAtMs(f.error);
      const breakerSkip = f.error instanceof LLMCircuitBreakerOpenError;
      const localSkip = f.localSkip === true || breakerSkip;
      return {
        providerId: f.providerId ?? this.providerIdOf(f.provider),
        // Phase 1968 Step B：显示名（label）与执行序/invocation 关联随失败事实持久化，
        // 改名与身份演化在恢复证据中可直接对齐（不经显示名反猜身份）。
        providerLabel: f.provider,
        configRevision: this.configGeneration,
        ...(invocationId !== undefined ? { invocationId } : {}),
        ...(attemptId !== undefined ? { attemptId } : {}),
        ...(f.attemptIndex !== undefined ? { attemptIndex: f.attemptIndex } : {}),
        errorClass: classifyLLMError(f.error),
        message: f.error.message,
        ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
        ...(resetAtMs !== undefined ? { resetAtMs } : {}),
        occurredAtMs: this.failureObservedAtMs.get(f.error) ?? Date.now(),
        ...(localSkip ? { localSkip } : {}),
      };
    });
  }

  /** 所有真实调用统一经过实例恢复 admission、开始事实与按 invocation 的 finish。 */
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

  /** 所有真实流式调用统一经过实例恢复；提前 return 也只 finish 本 invocation。 */
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

  /**
   * Get current provider info
   */
  getProviderInfo(): {
    name: string;
    model: string;
    isFallback: boolean;
  } {
    if (this.currentStreamingProvider) return this.currentStreamingProvider;
    if (this.lastSuccessProvider) {
      const { name, model, isFallback } = this.lastSuccessProvider;
      return { name, model, isFallback };
    }
    return { name: this.primary.name, model: this.primary.model, isFallback: false };
  }

  /**
   * Phase 1944 Step B：LLM 失败处置事实的唯一产出点（只读、无副作用）。
   * 映射本模块既有 classifyLLMError 结论为跨边界最小 union；provider retry/fallback/
   * breaker 状态机不移动，恢复安排仍在 scoped 调用内记录。非 LLM 失败归 'unknown'。
   */
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

  /** 白盒兼容薄委托；idle probe 的真实执行归 InvocationExecutor。 */
  private async _minimalProbe(
    provider: LLMProvider,
    timeoutMs: number,
    userSignal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: 'network_timeout' | 'auth_or_model'; error: Error }> {
    return this.invocationExecutor.minimalProbe(provider, timeoutMs, userSignal);
  }

  /**
   * Health check - quick validation that provider is reachable
   */
  async healthCheck(): Promise<boolean> {
    this.assertOpen();
    const adapters = [this.primary, ...this.fallbacks];
    const timeoutMs = 10_000; // healthCheck 默 10s（与既有 caller 0 timeout 行为等价）
    for (const adapter of adapters) {
      const result = await this._minimalProbe(adapter, timeoutMs);
      if (result.ok) return true;
      this.events.emit({
        type: 'healthcheck_failed',
        provider: adapter.name,
        error: result.error.message,
      });
    }
    return false;
  }
  
  /** Facade 先取消 probe，再由 ProviderRuntime 统一关闭 cache/pendingClose。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.scheduleGeneration += 1;
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    this.probeAbort?.abort();
    await this.providerRuntime.close();
  }

  /**
   * phase 320: 原地替换 primary/fallbacks/breakers，对象引用不变。
   * phase 899: reload 前记录旧 key set，reload 后淘汰不在新 config 中的 provider。
   * 同 ctor L98-131 同构（改 ctor 需同步改本方法、否则 reload 与起步态漂移）。
   * events 不动（装配期注入）。
   * lastSuccessProvider 重置：配置已变，上次成功的 provider 信息应失效。
   * currentStreamingProvider 不动（如有活跃 stream，配置替换不影响当前流）。
   */
  reloadConfig(newConfig: LLMOrchestratorConfig): void {
    this.assertOpen();
    // 先创建下一 adapter/identity 视图；V3 提交失败时不切换活动配置。
    const prepared = this.providerRuntime.prepareReload(newConfig);
    const newPrimary = prepared.primary;
    const newFallbacks = [...prepared.fallbacks];
    const newProviderIds = [newConfig.primary, ...(newConfig.fallbacks ?? [])].map(providerIdentity);
    const newLegacyProviderIds = [newConfig.primary, ...(newConfig.fallbacks ?? [])].map(legacyProviderIdentity);
    const currentIds = new Set(newProviderIds);
    const newProviderStates = this.providerStates
      .filter(provider => currentIds.has(provider.providerId))
      .map(provider => {
        const { lastSuccessAt: _lastSuccessAt, cacheValidUntil: _cacheValidUntil, ...retained } = provider;
        return retained;
      });
    const committed = this.commitInstanceCandidate({
      providers: newProviderStates,
      recovery: this.recoveryState,
    }, 'reload_config', newProviderIds, true);
    if (!committed) throw new Error('LLM instance state persistence failed during reloadConfig');

    this.probeCursor = 0;
    this.config = newConfig;
    this.providerRuntime.commitReload(prepared);
    this.primary = newPrimary;
    this.fallbacks = newFallbacks;
    this.providerIds = [...newProviderIds];
    this.legacyProviderIds = [...newLegacyProviderIds];
    this.recoveryController.setProviderIdentities(this.providerIds, this.legacyProviderIds);
    this.configGeneration += 1;
  }
}



export function createLLMOrchestrator(config: InstanceConfig): LLMOrchestratorOwner {
  return new LLMOrchestratorImpl(config);
}
