/**
 * LLMOrchestrator (L2b) types — retry/failover/hedge orchestration types.
 *
 * Base types (ProviderStreamChunk, ProviderConfig, ProviderAdapter, LLMCallOptions)
 * are owned by L1 llm-provider per M#5; L2b imports and extends them.
 *
 * Phase 1722 Step E: 组合流协议 `LLMStreamChunk` 归本模块 —— reset / provider_failed
 * 是多 provider 编排控制信号，不属于单 provider 调用协议。
 */

import type {
  ProviderStreamChunk,
  ProviderConfig,
  ProviderAdapter,
  PiAiCredentialStore,
  LLMCallOptions as L1LLMCallOptions,
} from '../llm-provider/index.js';
import type { LLMResponse } from '../llm-provider/index.js';
import { STREAM_EVENT_NAMES } from '../stream/index.js';
import type { LLMErrorClass, UserActionHint } from './errors.js';

/**
 * LLM call options — extends L1 base with L2b orchestration fields.
 */
export interface LLMCallOptions extends L1LLMCallOptions {
  /** Hard timeout for non-streaming call() — wall-clock ceiling */
  hardTimeoutMs?: number;
  /** Idle timeout for stream() — reset on each chunk */
  streamIdleTimeoutMs?: number;
  /** ⚓4 ε probe timeout after stream idle, default 5000ms */
  streamIdleProbeTimeoutMs?: number;
}

/**
 * LLM service configuration with failover
 */
export interface LLMOrchestratorConfig {
  primary: ProviderConfig;
  fallbacks?: ProviderConfig[];
  maxAttempts: number;
  retryDelayMs: number;
  events: LLMEventSink;
  circuitBreaker?: { failureThreshold: number; resetTimeoutMs: number };
  /** phase 1028: provider factory DI seam — tests inject mock adapter, production defaults to real adapter（Phase 1925 Step D 改名，旧名 createAnthropicAdapter） */
  createProviderAdapter?: (config: ProviderConfig) => ProviderAdapter;
  /**
   * Phase 1927 Step E：pi-ai CredentialStore 实例（装配根固定创建注入；
   * backend 生命周期内不漂移）。OAuth-capable catalog provider 缺席 → 装配期 loud。
   */
  credentialStore?: PiAiCredentialStore;
}

/**
 * LLM event payload union — emitted by LLMOrchestrator, consumed by fan-out adapter
 */
export type LLMEvent =
  // Phase 1268 Step C: 显式 maxAttempts + 可选 retryAfterSec；attempt 保持 owner 现有 0-based 语义，
  // 指“刚失败的 attempt”；presentation 自转 1-based，消费者不解析错误文本。
  | { type: typeof STREAM_EVENT_NAMES.PROVIDER_ATTEMPT_FAILED; provider: string; attempt: number; maxAttempts: number; error: string; errorClass: LLMErrorClass; userActionHint: UserActionHint; retryAfterSec?: number }
  | { type: typeof STREAM_EVENT_NAMES.RETRY_SCHEDULED; provider: string; attempt: number; maxAttempts: number; backoffMs: number }
  | { type: typeof STREAM_EVENT_NAMES.PROVIDER_EXHAUSTED; provider: string; error: string }
  | { type: typeof STREAM_EVENT_NAMES.FALLBACK_SWITCHED; from: string; to: string; reason: string }
  | { type: typeof STREAM_EVENT_NAMES.BREAKER_OPENED; provider: string; consecutiveFailures: number }
  | { type: typeof STREAM_EVENT_NAMES.BREAKER_HALF_OPEN; provider: string }
  | { type: typeof STREAM_EVENT_NAMES.BREAKER_CLOSED; provider: string }
  | { type: typeof STREAM_EVENT_NAMES.HEALTHCHECK_FAILED; provider: string; error: string }
  | { type: typeof STREAM_EVENT_NAMES.STREAM_RESET; provider: string; error: string }
  | { type: typeof STREAM_EVENT_NAMES.STREAM_PARSE_ERROR; provider: string; raw: string; error: string }
  | { type: typeof STREAM_EVENT_NAMES.TOOL_ARG_PARSE_ERROR; provider: string; toolName: string; rawArgs: string; error: string }
  | { type: typeof STREAM_EVENT_NAMES.IDLE_FAILOVER_TRIGGERED; provider: string; ms: number }
  | { type: typeof STREAM_EVENT_NAMES.STREAM_IDLE_PROBE_ATTEMPTED; provider: string; timeoutMs: number }
  | { type: typeof STREAM_EVENT_NAMES.STREAM_IDLE_PROBE_SUCCEEDED; provider: string }
  | { type: typeof STREAM_EVENT_NAMES.CONTEXT_EXCEEDED_FAILOVER; provider: string; stopReason: string }
  | { type: typeof STREAM_EVENT_NAMES.CONTEXT_EXCEEDED_THROWTHROUGH; provider: string }
  // Phase 1826: 确定性错误短路同时覆盖 permanent 与 quota（quota 走 owner 时间窗安排）。
  | { type: typeof STREAM_EVENT_NAMES.PERMANENT_SKIP_RETRY; provider: string; attempt: number; errorClass: 'permanent' | 'quota' }
  | { type: typeof STREAM_EVENT_NAMES.HEDGE_STARTED; primary: string; fallbackChain: string[]; triggerErrorClass: LLMErrorClass }
  | { type: typeof STREAM_EVENT_NAMES.HEDGE_PRIMARY_RECOVERED; provider: string; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
  | { type: typeof STREAM_EVENT_NAMES.HEDGE_PRIMARY_POST_FIRST_CHUNK_FAILURE; provider: string; error: Error }
  | { type: typeof STREAM_EVENT_NAMES.HEDGE_FALLBACK_COMMITTED; winnerProvider: string; primaryProvider: string; primaryError: string; primaryErrorClass: LLMErrorClass; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
  | { type: typeof STREAM_EVENT_NAMES.HEDGE_PRIMARY_SUCCEEDED_AFTER_RACE_LOST; primaryProvider: string; winnerProvider: string }
  | { type: typeof STREAM_EVENT_NAMES.ALL_PROVIDERS_CONTEXT_EXCEEDED; totalAttempted: number; skippedCount: number }
  | { type: typeof STREAM_EVENT_NAMES.RACE_LOSER_CLEANED; provider: string; reason: string }
  | { type: typeof STREAM_EVENT_NAMES.SDK_CLIENT_CACHE_HIT; preset: string; model: string }
  | { type: typeof STREAM_EVENT_NAMES.SDK_CLIENT_CACHE_MISS; preset: string; model: string }
  | { type: typeof STREAM_EVENT_NAMES.PROVIDER_CLOSE_FAILED; error: string }
  // Phase 1968 Step B：provider 调用路径可审计（LLM-CALL-SUCCESS-PROVENANCE-NOT-AUDITABLE）。
  // invocationId 关联一次 call/stream 的全部 attempt/selection 事实；attemptIndex 是
  // 实际执行序列号（含跳过），非配置数组下标；providerId 为不可逆身份指纹（不含凭据）。
  // outcome 'discarded'：候选已执行但未成为最终选择（hedge race loser 已产出内容）——
  // 不伪造成功也不伪造失败。
  | { type: typeof STREAM_EVENT_NAMES.CALL_INVOCATION_STARTED; invocationId: string; kind: 'call' | 'stream'; configRevision: number; candidates: { name: string; providerId: string }[] }
  | { type: typeof STREAM_EVENT_NAMES.CALL_ATTEMPT_RESULT; invocationId: string; attemptIndex: number; provider: string; providerId: string; outcome: 'success' | 'failure' | 'skipped' | 'discarded'; errorClass?: LLMErrorClass; error?: string; reason?: string }
  | { type: typeof STREAM_EVENT_NAMES.CALL_SELECTION; invocationId: string; outcome: 'selected' | 'exhausted'; provider?: string; providerId?: string; attemptIndex?: number }
  // 由装配层 sink 在审计持久化降级/失败时产生（LLMOrchestrator 不产生本事件）。
  | { type: typeof STREAM_EVENT_NAMES.CALL_AUDIT_WRITE_FAILED; eventType: string; invocationId?: string; reason: string }
  // Phase 1826: 恢复安排事件（owner 唯一发布；调用方只观察，不重算策略）
  | { type: typeof STREAM_EVENT_NAMES.RECOVERY_SCHEDULED; scope: string; revision: number; scheduleKind: 'at' | 'on_change'; resumeAt: string; errorClass: string; providerCount: number; failureCount: number }
  // Phase 1827: 事实接受证据（完整新事实；admission 事件的单 trigger 只是显示摘要）
  | { type: typeof STREAM_EVENT_NAMES.RECOVERY_FACTS_ACCEPTED; scope: string; revision: number; interventionIds: string[]; configurationRevision?: string; startupId?: string; attemptId?: string }
  | { type: typeof STREAM_EVENT_NAMES.RECOVERY_READY; scope: string; revision: number; reason: string }
  | { type: typeof STREAM_EVENT_NAMES.RECOVERY_ATTEMPT_ADMITTED; scope: string; revision: number; attemptId: string; trigger: string; interventionCount: number }
  | { type: typeof STREAM_EVENT_NAMES.RECOVERY_ATTEMPT_FINISHED; scope: string; revision: number; attemptId: string; outcome: string; accepted: boolean }
  | { type: typeof STREAM_EVENT_NAMES.RECOVERY_STATE_WRITE_FAILED; scope: string; reason: string; context: string };

/**
 * LLM event sink protocol — defined here (L2b), implemented by assembly layer (L6)
 * Error isolation: implementations must not throw; failures must be absorbed internally.
 */
export interface LLMEventSink {
  emit(event: LLMEvent): void;
}

/**
 * reset chunk — 多 provider 编排控制信号（stream idle/异常重置、重新挑 provider）。
 * 仅 LLMOrchestrator 产生；单 provider adapter 不可能 yield。
 */
export interface LLMStreamResetChunk {
  type: 'reset';

  /** Provider name that timed out */
  provider?: string;

  /** Timeout duration in ms */
  timeoutMs?: number;
}

/**
 * provider_failed chunk — 多 provider 编排控制信号（本 provider 流失败、转 failover）。
 * 仅 LLMOrchestrator 产生；单 provider adapter 不可能 yield。
 */
export interface LLMStreamProviderFailedChunk {
  type: 'provider_failed';

  /** Provider name that failed */
  provider?: string;

  /** Model name */
  model?: string;

  /** Error message */
  error?: string;
}

/**
 * Caller-facing 组合流协议（Phase 1722 Step E）：L1 单 provider chunk ∪ 本模块两个 control 成员。
 * 运行时对象 shape 与历史 `StreamChunk` 逐字一致；仅 owner 与命名面变化。
 */
export type LLMStreamChunk = ProviderStreamChunk | LLMStreamResetChunk | LLMStreamProviderFailedChunk;

/**
 * Phase 1944 Step B：LLM 失败处置事实（跨 Runtime/EventLoop 边界的最小 typed union）。
 * 唯一产出点为 LLMOrchestrator（内部由 classifyLLMError 派生）；上层只消费、不重算。
 * - provider_recovery_scheduled：provider/LLM 类失败（transient/rate_limit/quota/permanent），
 *   恢复安排已由 LLMOrchestrator 在 scoped 调用内唯一记录；
 * - context_exceeded：上下文超出（消费方保留专门处置路径）；
 * - abort：中断语义；
 * - unknown：非 LLM 失败或无法归类（消费方走通用 dispatch）。
 */
/**
 * Phase 1956 Step C：本分类只描述 LLM owner 的失败处置结论，不决定 dialog
 * 结算粒度——所有可恢复 turn failure 的 dialog 结算统一归 Runtime/DialogStore
 * 的最后 step 协议（discardCurrentStep），本类型不含 rollback 语义。
 */
export type LLMFailureDisposition =
  | 'provider_recovery_scheduled'
  | 'context_exceeded'
  | 'abort'
  | 'unknown';

/**
 * phase 1860 (RT-D1)：Runtime 私有消费面——仅 Runtime 实际调用集（M#7 最小）。
 * 签名 1:1 取自 LLMOrchestrator（orchestrator.ts 实现）；Runtime 侧宽持有收窄后
 * 经本 capability 消费，stream/call 等宽面仅经转发面（RuntimeDependencies.llmOrchestrator）传递。
 */
export interface LLMRuntimeCapability {
  getProviderInfo(): { name: string; model: string; isFallback: boolean };
  /**
   * Phase 1944 Step B：失败处置事实查询（只读、无副作用，不调度 retry、不改状态）。
   * 描述传入主失败的 owner 结论；rollback 的 AggregateError 包装由 Runtime 在包装前
   * 对原始失败求值，本方法不展开 AggregateError 内部因果。
   */
  getFailureDisposition(error: unknown): LLMFailureDisposition;
  /** 重置 lastSuccessProvider，下次 stream/call 从 primary 开始挑。Runtime 在每轮 turn 开始调。 */
  resetLastSuccessProvider(): void;
  close(): Promise<void>;
  /**
   * phase 320: 原地替换内部 primary/fallbacks/breakers，对象引用不变。
   * 调用方持有的引用自动指向新 provider；events sink 引用不换；lastSuccessProvider 不重置。
   */
  reloadConfig(newConfig: LLMOrchestratorConfig): void;
}

// ---------------------------------------------------------------------------
// Phase 1933 Step B：进程内共享状态的实例级能力（状态快照 / 独立探针）
// ---------------------------------------------------------------------------

/**
 * Phase 1933：单个 provider 的实例内故障快照（不含凭据）。
 */
export interface LLMProviderSnapshotEntry {
  provider: string;           // provider name
  isFallback: boolean;
  breakerOpen: boolean;
  openCause: string | null;   // breaker open 原因分类（无则 null）
  consecutiveFailures: number;
  /** breaker open 时最早允许探测的时刻（ms epoch）；未 open 时缺省。 */
  probeAllowedAtMs?: number;
}

/**
 * Phase 1933：实例级故障快照：进程内共享状态的只读视图。
 */
export interface LLMInstanceSnapshot {
  takenAtMs: number;
  providers: LLMProviderSnapshotEntry[];  // primary 在前
}

/**
 * Phase 1933：独立探针结果。ok=false 时 error 为显示摘要。
 * Phase 1934 Step C：保留失败分类与 typed Retry-After（替代只有 error 字符串），
 * 调用方不得从 error 文本推导策略。
 */
export interface LLMProbeResult {
  ok: boolean;
  provider: string;            // 实际探测的 provider
  probedAtMs: number;
  error?: string;
  /** 失败分类（ok=true 时缺省）。 */
  errorClass?: LLMErrorClass;
  /** typed Retry-After（秒；仅 rate_limit 且服务端给出时存在）。 */
  retryAfterSec?: number;
}

/**
 * LLMOrchestrator interface — multi-provider fault-tolerant LLM orchestration
 *
 * Implemented by LLMOrchestratorImpl class.
 */
export interface LLMOrchestrator {
  call(options: LLMCallOptions): Promise<LLMResponse>;
  stream(options: LLMCallOptions): AsyncIterableIterator<LLMStreamChunk>;
  healthCheck(): Promise<boolean>;
  getProviderInfo(): { name: string; model: string; isFallback: boolean };
  /**
   * Phase 1944 Step B：LLM 失败处置事实查询（与 LLMRuntimeCapability 同源；
   * 只读、无副作用。宽面与窄面契约上同一对象，事实结论唯一归本模块产出）。
   */
  getFailureDisposition(error: unknown): LLMFailureDisposition;
  /** 重置 lastSuccessProvider，下次 stream/call 从 primary 开始挑。Runtime 在每轮 turn 开始调。 */
  resetLastSuccessProvider(): void;
  close(): Promise<void>;
  /**
   * phase 320: 原地替换内部 primary/fallbacks/breakers，对象引用不变。
   * 调用方（execContext.llm / runtime.llm）持有的引用自动指向新 provider。
   * events sink 引用不换（装配期注入）；lastSuccessProvider 不重置（下次 call 自然更新）。
   */
  reloadConfig(newConfig: LLMOrchestratorConfig): void;
}
