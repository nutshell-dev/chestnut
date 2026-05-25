/**
 * LLM Provider (L1) types — single provider call primitives
 *
 * Owns LLM protocol-layer types (Message, ContentBlock, ToolUseBlock, etc.)
 * per interfaces/l1.md LLMProvider section: "本模块 own LLM 协议层 message、IO、tool definition type 单源"
 */

import type { ApiFormat } from './presets.js';
import type { AuditLog } from '../audit/index.js';

// ============================================================================
// LLM Protocol Message Types (L1 canonical)
// ============================================================================

export type Role = 'user' | 'assistant' | 'system';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface UnknownBlock {
  type: string;
  [key: string]: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | UnknownBlock;

export interface Message {
  role: Role;
  content: ContentBlock[] | string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JSONSchema7;
}

export interface LLMResponse {
  content: ContentBlock[];
  stop_reason: 'tool_use' | 'end_turn' | 'max_tokens' | string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  model?: string;
}

/** JSON Schema 7 type definitions (simplified) */
export interface JSONSchema7 {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | string;
  properties?: Record<string, JSONSchema7>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  items?: JSONSchema7;
  additionalProperties?: boolean | JSONSchema7;
  default?: unknown;
  [key: string]: unknown;
}

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

  /** Optional audit log for formatter guard events */
  auditLog?: AuditLog;
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
    /**
     * Partial input data for tool_use_delta events.
     *
     * **Protocol-layer note**: Provider SSE protocols differ in delivery mode:
     * - Anthropic SDK: incremental `partial_json` chunk (accumulate deltas to get full input)
     * - OpenAI: full `arguments` string batch (single chunk = complete)
     * - Gemini: `JSON.stringify(args)` batch (single chunk = complete)
     *
     * **Safe default**: string concatenation of all deltas works for all providers
     * (all are monotonically accumulating). Do **not** assume incremental semantics.
     */
    partialInput?: string;
  };

  /** Usage info (usually in final chunk) */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
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
