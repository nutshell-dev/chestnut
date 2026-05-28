/**
 * Custom Anthropic non-stream response parser — pure function
 * 抽自 custom-anthropic.ts (phase 642 / mirror phase 630)
 */

import type { LLMResponse, ContentBlock } from './types.js';
import { LLMEmptyResponseError } from './errors.js';

export interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; [key: string]: unknown }>;
  model: string;
  stop_reason: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export function parseAnthropicResponse(data: AnthropicResponse): LLMResponse {
  if (!Array.isArray(data.content)) {
    throw new Error('Invalid response: content must be array');
  }
  const content = data.content as ContentBlock[];

  // 0-chunk guard
  if (content.length === 0) {
    throw new LLMEmptyResponseError('anthropic');
  }

  return {
    content,
    stop_reason: data.stop_reason ?? 'end_turn',
    usage: data.usage,
    model: data.model,
  };
}
