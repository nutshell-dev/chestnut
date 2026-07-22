import { describe, expect, it } from 'vitest';
import {
  isContextExceededMessage,
  parseRetryAfter,
  throwHttpErrorResponse,
} from '../../../src/foundation/llm-provider/_helpers.js';
import { LLMContextExceededError } from '../../../src/foundation/llm-provider/errors.js';
import { LLMInvalidRequestError } from '../../../src/foundation/llm-provider/request-unicode.js';

describe('throwHttpErrorResponse', () => {
  it('throws LLMRateLimitError on 429 with retry-after seconds', async () => {
    const response = new Response('{"error":{"message":"rate limited"}}', {
      status: 429,
      headers: { 'retry-after': '60' },
    });
    await expect(throwHttpErrorResponse('test-provider', 'test-model', response))
      .rejects.toMatchObject({
        name: 'LLMRateLimitError',
        retryAfter: 60,
      });
  });

  it('throws LLMRateLimitError on 429 with no retry-after', async () => {
    const response = new Response('{"error":{"message":"rate limited"}}', { status: 429 });
    await expect(throwHttpErrorResponse('test-provider', 'test-model', response))
      .rejects.toMatchObject({
        name: 'LLMRateLimitError',
        retryAfter: undefined,
      });
  });

  it('throws LLMError "server error" on 500', async () => {
    const response = new Response('{"error":{"message":"oops"}}', { status: 503 });
    await expect(throwHttpErrorResponse('test-provider', 'test-model', response))
      .rejects.toThrow(/Provider test-provider server error \(503\): oops/);
  });

  it('throws LLMError generic on 4xx (non-429)', async () => {
    const response = new Response('{"error":{"message":"bad request"}}', { status: 400 });
    await expect(throwHttpErrorResponse('test-provider', 'test-model', response))
      .rejects.toThrow(/Provider test-provider error \(400\): bad request/);
  });

  it('falls back to text() if JSON parse fails', async () => {
    const response = new Response('plain text error', { status: 500 });
    await expect(throwHttpErrorResponse('test-provider', 'test-model', response))
      .rejects.toThrow(/Provider test-provider server error \(500\): plain text error/);
  });

  // phase 445: 404 用 caller 传入 model（权威源）、不再 regex 反查 errorText
  it('404 with natural-language body uses caller-supplied model name (not regex-extracted)', async () => {
    const response = new Response(
      '{"error":{"message":"The model does not exist or you do not have access"}}',
      { status: 404 },
    );
    await expect(throwHttpErrorResponse('custom-anthropic', 'glm5.2', response))
      .rejects.toMatchObject({
        name: 'LLMModelNotFoundError',
        message: expect.stringContaining('rejected model "glm5.2"'),
      });
  });

  it('404 attaches provider response snippet to error message', async () => {
    const response = new Response(
      '{"error":{"message":"The model does not exist"}}',
      { status: 404 },
    );
    await expect(throwHttpErrorResponse('custom-anthropic', 'glm5.2', response))
      .rejects.toThrow(/Provider response: The model does not exist/);
  });
});

describe('parseRetryAfter', () => {
  it('returns undefined for null', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseRetryAfter('')).toBeUndefined();
  });

  it('parses integer seconds', () => {
    expect(parseRetryAfter('5')).toBe(5);
  });

  it('still parses leading-int with trailing chars (parseInt semantics)', () => {
    expect(parseRetryAfter('60s')).toBe(60);
  });

  it('returns undefined for non-numeric (phase 592 revoke phase 563)', () => {
    expect(parseRetryAfter('abc')).toBeUndefined();
  });
});

/**
 * phase 690 Step A: LLMContextExceededError + throwHttpErrorResponse 400 识别
 */

describe('isContextExceededMessage', () => {
  it('matches OpenAI maximum context length', () => {
    expect(isContextExceededMessage("This model's maximum context length is 128000 tokens, but you requested 200000.")).toBe(true);
  });

  it('matches OpenAI reduce length hint', () => {
    expect(isContextExceededMessage('Please reduce the length of the messages.')).toBe(true);
  });

  it('matches OpenAI error code', () => {
    expect(isContextExceededMessage('context_length_exceeded')).toBe(true);
  });

  it('matches Anthropic prompt too long', () => {
    expect(isContextExceededMessage('prompt is too long: 250000 tokens > 200000 maximum')).toBe(true);
  });

  it('matches Anthropic input length + max_tokens', () => {
    expect(isContextExceededMessage('input length and `max_tokens` exceed context limit')).toBe(true);
  });

  it('matches Gemini token count exceed', () => {
    expect(isContextExceededMessage('The input token count exceeds the maximum')).toBe(true);
  });

  it('does NOT match generic 400 error', () => {
    expect(isContextExceededMessage('invalid_request: missing field "model"')).toBe(false);
  });

  it('does NOT match rate limit', () => {
    expect(isContextExceededMessage('Rate limit reached for requests')).toBe(false);
  });
});

describe('throwHttpErrorResponse 400 context-exceeded', () => {
  it('throws LLMContextExceededError on 400 with OpenAI context-length message', async () => {
    const response = new Response(
      '{"error":{"message":"This model\'s maximum context length is 8192 tokens, however you requested 9000 tokens"}}',
      { status: 400 },
    );
    await expect(throwHttpErrorResponse('test-provider', 'test-model', response))
      .rejects.toBeInstanceOf(LLMContextExceededError);
  });

  it('throws LLMContextExceededError on 400 with Anthropic prompt-too-long message', async () => {
    const response = new Response(
      '{"error":{"message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
      { status: 400 },
    );
    await expect(throwHttpErrorResponse('anthropic', 'claude-3', response))
      .rejects.toMatchObject({
        name: 'LLMContextExceededError',
        provider: 'anthropic',
        status: 400,
      });
  });

  it('throws generic LLMError on 400 NOT matching context or JSON parse patterns', async () => {
    const response = new Response(
      '{"error":{"message":"invalid_request: missing field model"}}',
      { status: 400 },
    );
    await expect(throwHttpErrorResponse('test-provider', 'test-model', response))
      .rejects.toMatchObject({
        name: 'LLMError',
      });
    // 不应是 LLMContextExceededError
    await expect(
      throwHttpErrorResponse('test-provider', 'test-model',
        new Response('{"error":{"message":"invalid_request: missing field model"}}', { status: 400 })
      )
    ).rejects.not.toBeInstanceOf(LLMContextExceededError);
    // 不应是 LLMInvalidRequestError
    await expect(
      throwHttpErrorResponse('test-provider', 'test-model',
        new Response('{"error":{"message":"invalid_request: missing field model"}}', { status: 400 })
      )
    ).rejects.not.toBeInstanceOf(LLMInvalidRequestError);
  });

  it('LLMContextExceededError exposes provider/status/providerMessage', async () => {
    const response = new Response(
      '{"error":{"message":"prompt is too long: 300000 > 200000"}}',
      { status: 400 },
    );
    try {
      await throwHttpErrorResponse('claude', 'claude-3', response);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMContextExceededError);
      const e = err as LLMContextExceededError;
      expect(e.provider).toBe('claude');
      expect(e.status).toBe(400);
      expect(e.providerMessage).toContain('prompt is too long');
      expect(e.code).toBe('LLM_CONTEXT_EXCEEDED');
    }
  });
});

