import { describe, expect, it } from 'vitest';
import {
  parseAnthropicResponse,
  type AnthropicResponse,
} from '../../../src/foundation/llm-provider/custom-anthropic-response-parser.js';
import {
  LLMEmptyResponseError,
  LLMError,
} from '../../../src/foundation/llm-provider/errors.js';

const PROVIDER_NAME = 'minimax-production';

const baseResponse: AnthropicResponse = {
  id: 'msg-1',
  type: 'message',
  role: 'assistant',
  content: [],
  model: 'minimax-model',
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 2 },
};

describe('parseAnthropicResponse provider identity', () => {
  it('invalid content reports adapter provider identity', () => {
    try {
      parseAnthropicResponse(
        { ...baseResponse, content: null } as unknown as AnthropicResponse,
        PROVIDER_NAME,
      );
      expect.unreachable('expected parser to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMError);
      expect((error as LLMError).context?.provider).toBe(PROVIDER_NAME);
    }
  });

  it('empty content reports adapter provider identity', () => {
    try {
      parseAnthropicResponse({ ...baseResponse, content: [] }, PROVIDER_NAME);
      expect.unreachable('expected parser to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMEmptyResponseError);
      expect((error as LLMEmptyResponseError).context?.provider).toBe(PROVIDER_NAME);
    }
  });

  it('successful response preserves parsed payload', () => {
    expect(
      parseAnthropicResponse(
        {
          ...baseResponse,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: null,
        },
        PROVIDER_NAME,
      ),
    ).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: baseResponse.usage,
      model: baseResponse.model,
    });
  });
});
