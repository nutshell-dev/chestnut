import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { Message, ContentBlock, ToolDefinition } from './types.js';

/**
 * LLM token estimator (pre-call fallback)
 *
 * **角色**：pre-call fallback、不替 post-call `LLMResponse.usage` 真值
 * - provider 提供 token data 时 (`response.usage.input_tokens / output_tokens`) caller 直接读、estimator 不参与
 * - provider 不提供 / pre-call budget 规划 / truncation decision 时 estimator fallback
 *
 * **技术选择**：js-tiktoken (官方 tiktoken Rust 实现的 pure JS port、cl100k_base baseline)
 *
 * **accuracy expectation**:
 * - OpenAI GPT-3.5 / GPT-4: 准 (cl100k_base 是其官方 encoding)
 * - Anthropic Claude 3 / 4: ±15-20% 偏差 (Claude 实际 BPE 类似但不同 vocab)
 * - Gemini: ±15-25% 偏差 (Google SentencePiece)
 * - 用于 budget 规划 / truncation decision OK、cost 精算需 provider 真值
 *
 * **multi-modal by-design 不支持**：image / audio block (UnknownBlock) JSON.stringify fallback 粗略
 */

/** Per-message overhead tokens (model boilerplate per Anthropic / OpenAI doc) */
export const PER_MESSAGE_OVERHEAD_TOKENS = 4;

/** Lazy singleton tiktoken encoding (cl100k_base baseline) */
let encodingCache: Tiktoken | null = null;

export function __resetForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__resetForTest is for tests only');
  }
  encodingCache = null;
}
function getEnc(): Tiktoken {
  if (encodingCache === null) {
    encodingCache = getEncoding('cl100k_base');
  }
  return encodingCache;
}

/** Estimate token count from raw text (js-tiktoken cl100k_base encoding) */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return getEnc().encode(text).length;
}

/** Estimate token count for a single content block */
function estimateContentBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text as string);
    case 'tool_use':
      return estimateTextTokens(block.name as string)
        + estimateTextTokens(JSON.stringify((block as { input?: unknown }).input ?? {}));
    case 'tool_result':
      return estimateTextTokens(block.content as string);
    case 'thinking':
      return estimateTextTokens(block.thinking as string);
    default:
      // UnknownBlock: multi-modal image / audio 等、by-design 不支持精确估算、JSON.stringify fallback 粗略
      return estimateTextTokens(JSON.stringify(block));
  }
}

/** Estimate token count for a single message (含 per-message overhead) */
export function estimateMessageTokens(msg: Message): number {
  let total = PER_MESSAGE_OVERHEAD_TOKENS;
  if (typeof msg.content === 'string') {
    total += estimateTextTokens(msg.content);
  } else {
    for (const block of msg.content) {
      total += estimateContentBlockTokens(block);
    }
  }
  return total;
}

/** Estimate token count for messages array */
export function estimateMessagesTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/** Estimate token count for a single tool definition (name + description + JSON schema) */
export function estimateToolTokens(tool: ToolDefinition): number {
  return estimateTextTokens(tool.name)
    + estimateTextTokens(tool.description)
    + estimateTextTokens(JSON.stringify(tool.input_schema));
}

/** Estimate token count for tools array */
export function estimateToolsTokens(tools: readonly ToolDefinition[]): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateToolTokens(tool);
  }
  return total;
}

/** Composite input token estimate options */
export interface InputTokenEstimateOptions {
  systemPrompt?: string;
  messages: readonly Message[];
  tools?: readonly ToolDefinition[];
}

/** Composite input token estimate breakdown */
export interface InputTokenEstimate {
  systemPromptTokens: number;
  messagesTokens: number;
  toolsTokens: number;
  total: number;
}

/**
 * Estimate input tokens for an LLM API call (composite breakdown)
 *
 * Returns breakdown by source (systemPrompt / messages / tools) for cost attribution.
 */
export function estimateInputTokens(input: InputTokenEstimateOptions): InputTokenEstimate {
  const systemPromptTokens = input.systemPrompt ? estimateTextTokens(input.systemPrompt) : 0;
  const messagesTokens = estimateMessagesTokens(input.messages);
  const toolsTokens = input.tools ? estimateToolsTokens(input.tools) : 0;
  return {
    systemPromptTokens,
    messagesTokens,
    toolsTokens,
    total: systemPromptTokens + messagesTokens + toolsTokens,
  };
}
