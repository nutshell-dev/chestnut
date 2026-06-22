/**
 * LLMOrchestrator (L2b) types — retry/failover/hedge orchestration types.
 *
 * Base types (StreamChunk, ProviderConfig, ProviderAdapter, LLMCallOptions)
 * are owned by L1 llm-provider per M#5; L2b imports and extends them.
 */

import type {
  StreamChunk,
  ProviderConfig as L1ProviderConfig,
  ProviderAdapter,
  LLMCallOptions as L1LLMCallOptions,
} from '../llm-provider/types.js';
import type { LLMResponse } from '../llm-provider/types.js';
import type { LLMErrorClass, UserActionHint } from './errors.js';

// Re-export L1 base types for backward compat
export type { StreamChunk, ProviderAdapter };
export type ProviderConfig = L1ProviderConfig;

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
}

/**
 * LLM event payload union — emitted by LLMOrchestrator, consumed by fan-out adapter
 */
export type LLMEvent =
  | { type: 'provider_attempt_failed'; provider: string; attempt: number; error: string; errorClass: LLMErrorClass; userActionHint: UserActionHint }
  | { type: 'retry_scheduled'; provider: string; attempt: number; backoffMs: number }
  | { type: 'provider_exhausted'; provider: string; error: string }
  | { type: 'fallback_switched'; from: string; to: string; reason: string }
  | { type: 'breaker_opened'; provider: string; consecutiveFailures: number }
  | { type: 'breaker_half_open'; provider: string }
  | { type: 'breaker_closed'; provider: string }
  | { type: 'healthcheck_failed'; provider: string; error: string }
  | { type: 'stream_reset'; provider: string; error: string }
  | { type: 'stream_parse_error'; provider: string; raw: string; error: string }
  | { type: 'tool_arg_parse_error'; provider: string; toolName: string; rawArgs: string; error: string }
  | { type: 'idle_failover_triggered'; provider: string; ms: number }
  | { type: 'stream_idle_probe_attempted'; provider: string; timeoutMs: number }
  | { type: 'stream_idle_probe_succeeded'; provider: string }
  | { type: 'context_exceeded_failover'; provider: string; stopReason: string }
  | { type: 'context_exceeded_throwthrough'; provider: string }
  | { type: 'permanent_skip_retry'; provider: string; attempt: number; errorClass: 'permanent' }
  | { type: 'hedge_started'; primary: string; fallbackChain: string[]; triggerErrorClass: LLMErrorClass }
  | { type: 'hedge_primary_recovered'; provider: string; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
  | { type: 'hedge_primary_post_first_chunk_failure'; provider: string; error: Error }
  | { type: 'hedge_fallback_committed'; winnerProvider: string; primaryProvider: string; primaryError: string; primaryErrorClass: LLMErrorClass; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
  | { type: 'hedge_primary_succeeded_after_race_lost'; primaryProvider: string; winnerProvider: string }
  | { type: 'all_providers_context_exceeded'; totalAttempted: number; skippedCount: number }
  | { type: 'race_loser_cleaned'; provider: string; reason: string }
  | { type: 'sdk_client_cache_hit'; preset: string; model: string }
  | { type: 'sdk_client_cache_miss'; preset: string; model: string };

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
  getProviderInfo(): { name: string; model: string; isFallback: boolean } | null;
  close(): Promise<void>;
  /**
   * phase 320: 原地替换内部 primary/fallbacks/breakers，对象引用不变。
   * 调用方（execContext.llm / runtime.llm）持有的引用自动指向新 provider。
   * events sink 引用不换（装配期注入）；lastSuccessProvider 不重置（下次 call 自然更新）。
   */
  reloadConfig(newConfig: LLMOrchestratorConfig): void;
}
