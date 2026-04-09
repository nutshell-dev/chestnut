/**
 * LLM module internal types
 * No external dependencies to avoid circular imports
 */

import type { Message, ToolDefinition, LLMResponse } from '../../types/message.js';
import type { ApiFormat } from './presets.js';

// Re-export from central types for convenience
export type { Message, ToolDefinition, LLMResponse };

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
export interface LLMServiceConfig {
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

  /** Circuit breaker configuration (optional) */
  circuitBreaker?: { failureThreshold: number; resetTimeoutMs: number };
}

/**
 * Streaming response chunk
 */
export interface StreamChunk {
  type: 'text_delta' | 'thinking_delta' | 'thinking_signature' | 'tool_use_start' | 'tool_use_delta' | 'done' | 'reset';
  
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
  
  /** Signal for cancellation */
  signal?: AbortSignal;
}

/**
 * LLM Provider adapter interface
 * Each provider (Anthropic, OpenAI, etc.) implements this
 */
export interface IProviderAdapter {
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
}
