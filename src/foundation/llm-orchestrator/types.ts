/**
 * LLM module internal types
 * No external dependencies to avoid circular imports
 */

import type { Message, ToolDefinition, LLMResponse } from '../../types/message.js';
import type { ApiFormat } from '../llm-provider/presets.js';
import type { LLMErrorClass, UserActionHint } from '../../types/errors.js';

/**
 * Single provider configuration
 */
export interface ProviderConfig {
  /** Provider name (for identification) */
  name: string;
  
  /** API key */
  apiKey: string;
  
  /** Base URL (optional, uses default if not set) */
  baseUrl?: string;
  
  /** Model identifier */
  model: string;
  
  /** Maximum tokens to generate */
  maxTokens: number;
  
  /** Temperature (0-2) */
  temperature: number;
  
  /** Timeout in milliseconds */
  timeoutMs: number;
  
  /** Enable extended thinking (for Anthropic Claude) */
  thinking?: boolean;
  
  /** Extended thinking budget tokens (defaults to max_tokens - 1024) */
  thinkingBudgetTokens?: number;

  /** Thinking mode: 'adaptive' for Claude 4.6+, 'enabled' (budget_tokens) for older models */
  thinkingMode?: 'adaptive' | 'enabled';

  /** Effort level for adaptive thinking (Claude 4.6+), defaults to 'high' */
  thinkingEffort?: 'low' | 'medium' | 'high';

  /** Extra headers to include in API requests (e.g., for OpenRouter) */
  extraHeaders?: Record<string, string>;

  /** Drop thinking blocks when sending messages (for MiniMax and other providers that don't support them) */
  dropThinkingBlocks?: boolean;

  /** API format, resolved from preset */
  apiFormat: ApiFormat;

  /** Reasoning effort for OpenAI o-series models */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

/**
 * LLM service configuration with failover
 */
export interface LLMOrchestratorConfig {
  /** Primary provider */
  primary: ProviderConfig;
  
  /** Fallback providers (optional, 0-N, tried in order) */
  fallbacks?: ProviderConfig[];
  
  /** 
   * Maximum total attempts for primary (including initial call + retries)
   * e.g., maxAttempts=3 means 1 initial attempt + up to 2 retries
   */
  maxAttempts: number;
  
  /** Delay between retries (exponential backoff base) */
  retryDelayMs: number;

  /** Event sink for structured observability (required, injected by assembly layer) */
  events: LLMEventSink;

  /** Circuit breaker configuration (optional) */
  circuitBreaker?: { failureThreshold: number; resetTimeoutMs: number };
}

/**
 * Streaming response chunk
 */
export interface StreamChunk {
  type: 'text_delta' | 'thinking_delta' | 'thinking_signature' | 'tool_use_start' | 'tool_use_delta' | 'done' | 'reset' | 'provider_failed';
  
  /** Text delta (for text_delta type) */
  delta?: string;
  
  /** Tool use info */
  toolUse?: {
    id: string;
    name: string;
    partialInput?: string;
  };
  
  /** Usage info (usually in final chunk) */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };

  /** Thinking block signature (for Anthropic extended thinking) */
  signature?: string;

  /** Stop reason (only in type='done' chunk) */
  stopReason?: string;

  /** Provider name that timed out (only in type='reset' chunk) */
  provider?: string;

  /** Timeout duration in ms (only in type='reset' chunk) */
  timeoutMs?: number;

  /** Error message (only in type='provider_failed' chunk) */
  error?: string;

  /** Model name (only in type='provider_failed' chunk) */
  model?: string;
}

/**
 * Options for a single LLM call
 */
export interface LLMCallOptions {
  /** Conversation messages */
  messages: Message[];
  
  /** System prompt (optional) */
  system?: string;
  
  /** Available tools for function calling */
  tools?: ToolDefinition[];
  
  /** Maximum tokens to generate */
  maxTokens?: number;
  
  /** Temperature (0-2) */
  temperature?: number;
  
  /** Override model for this call */
  model?: string;
  
  /** Timeout in milliseconds */
  timeoutMs?: number;
  
  /** Signal for cancellation (user abort + step_yield only; idle timeout is service-internal) */
  signal?: AbortSignal;

  /** Hard timeout for non-streaming call() — wall-clock ceiling */
  hardTimeoutMs?: number;

  /** Idle timeout for stream() — reset on each chunk / 仅 stream 路径 */
  streamIdleTimeoutMs?: number;

  /** ⚓4 ε probe timeout after stream idle, default 5000ms */
  streamIdleProbeTimeoutMs?: number;
}

/**
 * LLM Provider adapter interface
 * Each provider (Anthropic, OpenAI, etc.) implements this
 */
export interface ProviderAdapter {
  /** Provider name */
  readonly name: string;
  
  /** Current model */
  readonly model: string;
  
  /**
   * Make a single LLM call
   */
  call(options: LLMCallOptions): Promise<LLMResponse>;
  
  /**
   * Stream LLM response
   */
  stream?(options: LLMCallOptions): AsyncIterableIterator<StreamChunk>;

  /** Set by LLMOrchestratorImpl; providers call this for SSE parse errors (A.4) */
  onStreamParseError?: (event: { provider: string; raw: string; error: string }) => void;

  /** Set by LLMOrchestratorImpl; providers call this when tool_call.function.arguments fails JSON.parse */
  onToolArgParseError?: (event: { provider: string; toolName: string; rawArgs: string; error: string }) => void;
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
  | { type: 'permanent_skip_retry'; provider: string; attempt: number; errorClass: 'permanent' }
  | { type: 'hedge_started'; primary: string; fallbackChain: string[]; triggerErrorClass: LLMErrorClass }
  | { type: 'hedge_primary_recovered'; provider: string }
  | { type: 'hedge_primary_post_first_chunk_failure'; provider: string; error: Error }
  | { type: 'hedge_fallback_committed'; winnerProvider: string; primaryProvider: string; primaryError: string; primaryErrorClass: LLMErrorClass }
  | { type: 'hedge_primary_succeeded_after_race_lost'; primaryProvider: string; winnerProvider: string };

/**
 * LLM event sink protocol — defined here (L1), implemented by assembly layer (L6+)
 * Error isolation: implementations must not throw; failures must be absorbed internally.
 */
export interface LLMEventSink {
  emit(event: LLMEvent): void;
}
