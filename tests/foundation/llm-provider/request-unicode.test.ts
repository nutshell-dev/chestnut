import { describe, it, expect } from 'vitest';
import {
  LLMInvalidRequestError,
  serializeProviderRequest,
} from '../../../src/foundation/llm-provider/request-unicode.js';

describe('serializeProviderRequest', () => {
  it('serializes well-formed request body', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello 中文 😀' }],
    };
    expect(serializeProviderRequest('openai', body)).toBe(JSON.stringify(body));
  });

  it('rejects lone surrogate in message content', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'a\uD83Db' }],
    };
    expect(() => serializeProviderRequest('openai', body)).toThrow(LLMInvalidRequestError);
    try {
      serializeProviderRequest('openai', body);
      expect.fail('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMInvalidRequestError);
      expect((error as LLMInvalidRequestError).reason).toBe('invalid_unicode');
      expect((error as LLMInvalidRequestError).valuePath).toBe('$.messages[0].content');
      expect((error as LLMInvalidRequestError).codeUnitIndex).toBe(1);
    }
  });

  it('rejects lone surrogate in object key', () => {
    const body = { '\uD83D': 'value' };
    expect(() => serializeProviderRequest('openai', body)).toThrow(LLMInvalidRequestError);
  });

  it('rejects lone surrogate in nested tool input', () => {
    const body = {
      tools: [{
        function: {
          name: 'write',
          parameters: { properties: { content: { default: 'a\uDC00b' } } },
        },
      }],
    };
    expect(() => serializeProviderRequest('openai', body)).toThrow(LLMInvalidRequestError);
  });

  it('rejects circular reference as invalid request', () => {
    const body: Record<string, unknown> = { a: 1 };
    body.self = body;
    expect(() => serializeProviderRequest('openai', body)).toThrow(LLMInvalidRequestError);
  });

  it('preserves non-string primitives', () => {
    const body = { max_tokens: 100, temperature: 0.5, stream: true, tools: null };
    expect(serializeProviderRequest('openai', body)).toBe(JSON.stringify(body));
  });
});
