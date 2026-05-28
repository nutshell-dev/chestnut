/**
 * OpenAI 非流式 response 解析
 * 抽自 openai.ts (phase 630 / 形态 A.3 functional + class-bound observability)
 * dep: providerName + onToolArgParseError? callback
 */

import type { LLMResponse, ContentBlock } from './types.js';
import { LLMEmptyResponseError } from './errors.js';

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export type ToolArgParseErrorCallback = (event: {
  provider: string;
  toolName: string;
  rawArgs: string;
  error: string;
}) => void;

/**
 * Decode HTML entities in tool call arguments (xAI/grok sometimes HTML-encodes JSON)
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * Parse OpenAI 非流式响应（含 tool args JSON.parse + decodeHtmlEntities fallback）
 */
export function parseResponse(
  data: OpenAIResponse,
  providerName: string,
  onToolArgParseError?: ToolArgParseErrorCallback,
): LLMResponse {
  const choice = data.choices[0];
  const message = choice?.message;
  const content: ContentBlock[] = [];

  // OpenAI o-series reasoning content
  if (message?.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content } as ContentBlock);
  }

  // Text content
  if (message?.content) {
    content.push({ type: 'text', text: message.content });
  }

  // Tool calls
  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      try {
        const input = JSON.parse(decodeHtmlEntities(tc.function.arguments));
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        });
      } catch (err) {
        // JSON.parse failed (LLM returned malformed args) → emit audit then __parseError path (aligns with Anthropic streaming)
        onToolArgParseError?.({
          provider: providerName,
          toolName: tc.function.name,
          rawArgs: tc.function.arguments,
          error: err instanceof Error ? err.message : String(err),
        });
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: { __parseError: true, __raw: decodeHtmlEntities(tc.function.arguments) },
        });
      }
    }
  }

  // 0-chunk guard
  if (content.length === 0) {
    throw new LLMEmptyResponseError('openai');
  }

  // Normalize stop_reason to internal format
  const finishReason = choice?.finish_reason ?? 'stop';
  const stopReason =
    finishReason === 'tool_calls'
      ? 'tool_use'
      : finishReason === 'length'
        ? 'max_tokens'
        : finishReason === 'stop'
          ? 'end_turn'
          : finishReason;

  return {
    content,
    stop_reason: stopReason,
    usage: data.usage
      ? {
          input_tokens: data.usage.prompt_tokens,
          output_tokens: data.usage.completion_tokens,
        }
      : undefined,
    model: data.model,
  };
}
