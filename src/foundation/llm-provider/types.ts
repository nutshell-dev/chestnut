/**
 * LLM Provider (L1) types — single provider call primitives
 *
 * Owns LLM protocol-layer types (Message, ContentBlock, ToolUseBlock, etc.)
 * per interfaces/l1.md LLMProvider section: "本模块 own LLM 协议层 message、IO、tool definition type 单源"
 */

import type { ApiFormat } from './presets.js';
import type { ToolUseId } from './tool-use-id.js';
import type { AuditLog } from '../audit/types.js';
export type { AuditLog } from '../audit/types.js';

/** Minimal audit sink interface — L1 owns this duck-typed interface, L2b implements */
export interface AuditSink {
  write(event: string, ...details: string[]): void;
}

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
  id: ToolUseId;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: ToolUseId;
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

  // chestnut 内部元数据（LLM API 调用前 sanitize 剥离、API 仅看 role + content）
  // phase 436 立、phase 421 ratify、phase C 消费 (24h 边界 + P3 子类型分流 + trimmed 已裁过判)

  /** 仅 role='user' 时有意义；tool_result 不填（内部 block.type 已区分） */
  origin?: 'user' | 'system';

  /** = InboxMessage.type 字面单源、role='user' + origin='system' 时填 */
  systemSubtype?: string;

  /** 消息写入时刻 ISO（24h 边界判断依据、phase C ContextManager 消费） */
  addedAt?: string;

  /** phase C ContextManager 触发裁剪时填、本 Step 仅立 schema */
  trimmed?: {
    trimmedAt: string;
    originalContentBytes: number;
    timesTrimmed?: number;
  };
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
  maxTokens?: number;

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

  /** Optional audit sink for formatter guard events / SSE parse error clipping (L2b injects via config) */
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
