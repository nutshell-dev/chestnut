/**
 * LLMOrchestrator (L2b) types — retry/failover/hedge orchestration types.
 *
 * Base types (StreamChunk, ProviderConfig, ProviderAdapter, LLMCallOptions)
 * are owned by L1 llm-provider per M#5; L2b imports and extends them.
 */

import type {
  StreamChunk,
  ProviderConfig,
  ProviderAdapter,
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
  /** phase 1028: AnthropicAdapter factory DI seam — tests inject mock adapter, production defaults to real adapter */
  createAnthropicAdapter?: (config: ProviderConfig) => ProviderAdapter;
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
  | { type: typeof STREAM_EVENT_NAMES.PERMANENT_SKIP_RETRY; provider: string; attempt: number; errorClass: 'permanent' }
  | { type: typeof STREAM_EVENT_NAMES.HEDGE_STARTED; primary: string; fallbackChain: string[]; triggerErrorClass: LLMErrorClass }
  | { type: typeof STREAM_EVENT_NAMES.HEDGE_PRIMARY_RECOVERED; provider: string; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
  | { type: typeof STREAM_EVENT_NAMES.HEDGE_PRIMARY_POST_FIRST_CHUNK_FAILURE; provider: string; error: Error }
  | { type: typeof STREAM_EVENT_NAMES.HEDGE_FALLBACK_COMMITTED; winnerProvider: string; primaryProvider: string; primaryError: string; primaryErrorClass: LLMErrorClass; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
  | { type: typeof STREAM_EVENT_NAMES.HEDGE_PRIMARY_SUCCEEDED_AFTER_RACE_LOST; primaryProvider: string; winnerProvider: string }
  | { type: typeof STREAM_EVENT_NAMES.ALL_PROVIDERS_CONTEXT_EXCEEDED; totalAttempted: number; skippedCount: number }
  | { type: typeof STREAM_EVENT_NAMES.RACE_LOSER_CLEANED; provider: string; reason: string }
  | { type: typeof STREAM_EVENT_NAMES.SDK_CLIENT_CACHE_HIT; preset: string; model: string }
  | { type: typeof STREAM_EVENT_NAMES.SDK_CLIENT_CACHE_MISS; preset: string; model: string }
  | { type: typeof STREAM_EVENT_NAMES.PROVIDER_CLOSE_FAILED; error: string };

/**
 * LLM event sink protocol — defined here (L2b), implemented by assembly layer (L6)
 * Error isolation: implementations must not throw; failures must be absorbed internally.
 */
export interface LLMEventSink {
  emit(event: LLMEvent): void;
}

/**
 * LLMOrchestrator interface — multi-provider fault-tolerant LLM orchestration
 *
 * Implemented by LLMOrchestratorImpl class.
 */
export interface LLMOrchestrator {
  call(options: LLMCallOptions): Promise<LLMResponse>;
  stream(options: LLMCallOptions): AsyncIterableIterator<StreamChunk>;
  healthCheck(): Promise<boolean>;
  getProviderInfo(): { name: string; model: string; isFallback: boolean };
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
