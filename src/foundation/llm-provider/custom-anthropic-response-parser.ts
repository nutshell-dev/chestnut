/**
 * Custom Anthropic non-stream response parser — pure function
 * 抽自 custom-anthropic.ts (phase 642 / mirror phase 630)
 */

import type { LLMResponse, ContentBlock } from '../../types/message.js';

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
  const content = data.content as ContentBlock[];

  return {
    content,
    stop_reason: data.stop_reason ?? 'end_turn',
    usage: data.usage,
    model: data.model,
  };
}
