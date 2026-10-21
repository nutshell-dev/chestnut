/**
 * LLM Provider (L1) types — single provider call primitives
 *
 * Owns LLM protocol-layer types (Message, ContentBlock, ToolUseBlock, etc.)
 * per interfaces/l1.md LLMProvider section: "本模块 own LLM 协议层 message、IO、tool definition type 单源"
 */

import type { ApiFormat, AuthProfile } from './presets.js';
import type { ToolUseId } from './tool-use-id.js';

// phase 692 Step A: 删 AuditLog import + re-export
// L1 LLMProvider 收窄至 AuditSink (L1 owned duck-typed)、不知 L2a AuditLog 业务概念。
// 实际 callsite 全用 .write() 单方法、AuditSink 足够覆盖、M#8 界面最小严守。

/**
 * Minimal audit sink interface — L1 owns this duck-typed interface, L2b implements.
 * phase 692 Step A: 加 preview()、收 LLMProvider 4 callsite (custom-anthropic / gemini /
 * openai / openai-message-formatter) 真用方法集（write + preview）。preview 是 string
 * truncation 工具、非 audit business concept、L1 可 own。message/summary 是 audit 业务级
 * 截断（reason / tool_result 长度配置），LLMProvider 不用、保留在 AuditLog L2a 不外露。
 */
export interface AuditSink {
  write(event: string, ...details: string[]): void;
  /** Truncate s to a short preview length (caller-agnostic, L1 接口契约) */
  preview(s: string): string;
}

// ============================================================================
// LLM Protocol Message Types (L1 canonical)
// ============================================================================

type Role = 'user' | 'assistant' | 'system';

export interface TextBlock {
  type: 'text';
  text: string;
  blockId?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: ToolUseId;
  name: string;
  input: Record<string, unknown>;
  blockId?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: ToolUseId;
  content: string;
  is_error?: boolean;
  blockId?: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
  blockId?: string;
}

interface UnknownBlock {
  type: string;
  [key: string]: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | UnknownBlock;

/**
 * phase 1800: Provider wire message —— LLM API 仅看 role + content。
 *
 * chestnut 内部元数据（origin/systemSubtype/addedAt/trimmed）不属于 wire 协议，
 * 归 DialogStore canonical `Message`（phase 436 立、phase 421 ratify）；provider 类型面
 * 不暴露上层元数据。生产 pi-ai 路径的投影由 pi-ai-wire.buildPiAiContext 完成
 * （重建消息只取 role/content）；sanitizeForLLMCall 是做同一纯投影的测试/工具 helper
 * （phase 1961 Step C 名实核对：生产零调用）。
 */
export interface ProviderWireMessage {
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

  /**
   * API key。Phase 1926 Step D：ambient（AWS 链 / ADC / provider env）与 OAuth
   * provider 可为 undefined——请求期由 pi-ai 原生 auth.resolve（env/ambient/
   * stored credential）裁决；api_key profile 仍必填（provider-factory 校验）。
   */
  apiKey?: string;

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

  /**
   * API format, resolved from preset。catalog 命中（piAiProvider + model）时
   * 不参与协议裁决（catalog model.api 权威）；自建 Model 路径必填。
   */
  apiFormat?: ApiFormat;

  /**
   * Phase 1926 Step D：认证装配类别（由 preset 经 config-adapter 带入）。
   * 缺席按 'api_key' 处理（back-compat）；ambient/oauth 时 apiKey 可缺席。
   */
  authProfile?: AuthProfile;

  /** Reasoning effort for OpenAI o-series models */
  reasoningEffort?: 'low' | 'medium' | 'high';

  /**
   * Phase 1925 Step C：pi-ai catalog provider id（由 preset.piAiProvider 经 config-adapter 带入）。
   * catalog (piAiProvider, model) 命中时以 catalog model 为权威（api/baseUrl/能力元数据）；
   * undefined → 显式自建 Model（apiFormat 显式协议 + baseUrl），不做相似度猜测。
   */
  piAiProvider?: string;

  /** Optional audit sink for formatter guard events / SSE parse error clipping (L2b injects via config) */
  auditLog?: AuditSink;
}

/**
 * Streaming response chunk — 单 provider 调用协议（Phase 1722 Step E）。
 * 只含单 provider 可能产生的 content/done/usage 成员；
 * 多 provider 编排控制成员（reset / provider_failed）归 LLMOrchestrator `LLMStreamChunk`。
 */
export interface ProviderStreamChunk {
  type: 'text_delta' | 'thinking_delta' | 'thinking_signature' | 'tool_use_start' | 'tool_use_delta' | 'done';

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
}

/**
 * Options for a single LLM call
 */
export interface LLMCallOptions {
  /** Conversation messages（phase 1800: wire 类型；canonical 元数据由 caller 侧 DialogStore Message 承载） */
  messages: ProviderWireMessage[];

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
 * LLMProvider interface — single provider call primitive
 *
 * Implemented by all provider adapters (Anthropic, OpenAI, Gemini, etc.)
 */
export interface LLMProvider extends ProviderAdapter {}

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
  stream?(options: LLMCallOptions): AsyncIterableIterator<ProviderStreamChunk>;
}
