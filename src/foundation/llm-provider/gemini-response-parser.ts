/**
 * Gemini non-stream response parser — pure function
 * 抽自 gemini.ts (phase 642 / mirror phase 630)
 */

import type { LLMResponse, ContentBlock } from './types.js';
import { LLMEmptyResponseError } from './errors.js';

export interface GeminiResponse {
  candidates: Array<{
    content: {
      role: 'user' | 'model';
      parts: Array<
        | { text: string }
        | { functionCall: { name: string; args: Record<string, unknown> } }
      >;
    };
    finishReason: string;
  }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

export function parseGeminiResponse(data: GeminiResponse): LLMResponse {
  const candidate = data.candidates?.[0];

  // Content filtered or generation failed
  if (!candidate?.content?.parts) {
    const reason = candidate?.finishReason ?? 'UNKNOWN';
    return {
      content: [{ type: 'text', text: '' }],
      stop_reason: reason === 'SAFETY' ? 'content_filter' : 'end_turn',
      usage: data.usageMetadata ? {
        input_tokens: data.usageMetadata.promptTokenCount,
        output_tokens: data.usageMetadata.candidatesTokenCount,
      } : undefined,
    };
  }

  const content: ContentBlock[] = [];
  let fcIndex = 0;

  for (const part of candidate.content.parts) {
    if ('text' in part) {
      content.push({ type: 'text', text: part.text });
    } else if ('functionCall' in part) {
      const { name, args } = part.functionCall;
      if (!name) throw new Error('Gemini returned functionCall without name');
      content.push({ type: 'tool_use', id: `gemini-${name}-${fcIndex++}`, name, input: args });
    }
  }

  // 0-chunk guard
  if (content.length === 0) {
    throw new LLMEmptyResponseError('gemini');
  }

  const finishReason = candidate.finishReason ?? 'STOP';
  const hasToolUse = content.some(b => b.type === 'tool_use');
  const stopReason =
    hasToolUse                      ? 'tool_use' :
    finishReason === 'MAX_TOKENS'   ? 'max_tokens' :
    finishReason === 'SAFETY'       ? 'content_filter' :
    'end_turn';
  return {
    content,
    stop_reason: stopReason,
    usage: data.usageMetadata ? {
      input_tokens: data.usageMetadata.promptTokenCount,
      output_tokens: data.usageMetadata.candidatesTokenCount,
    } : undefined,
  };
}
