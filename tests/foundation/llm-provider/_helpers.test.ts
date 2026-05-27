import { describe, it, expect } from 'vitest';
import { parseRetryAfter, throwHttpErrorResponse } from '../../../src/foundation/llm-provider/_helpers.js';

describe('throwHttpErrorResponse', () => {
  it('throws LLMRateLimitError on 429 with retry-after seconds', async () => {
    const response = new Response('{"error":{"message":"rate limited"}}', {
      status: 429,
      headers: { 'retry-after': '60' },
    });
    await expect(throwHttpErrorResponse('test-provider', response))
      .rejects.toMatchObject({
        name: 'LLMRateLimitError',
        retryAfter: 60,
      });
  });

  it('throws LLMRateLimitError on 429 with no retry-after', async () => {
    const response = new Response('{"error":{"message":"rate limited"}}', { status: 429 });
    await expect(throwHttpErrorResponse('test-provider', response))
      .rejects.toMatchObject({
        name: 'LLMRateLimitError',
        retryAfter: undefined,
      });
  });

  it('throws LLMError "server error" on 500', async () => {
    const response = new Response('{"error":{"message":"oops"}}', { status: 503 });
    await expect(throwHttpErrorResponse('test-provider', response))
      .rejects.toThrow(/Provider test-provider server error \(503\): oops/);
  });

  it('throws LLMError generic on 4xx (non-429)', async () => {
    const response = new Response('{"error":{"message":"bad request"}}', { status: 400 });
    await expect(throwHttpErrorResponse('test-provider', response))
      .rejects.toThrow(/Provider test-provider error \(400\): bad request/);
  });

  it('falls back to text() if JSON parse fails', async () => {
    const response = new Response('plain text error', { status: 500 });
    await expect(throwHttpErrorResponse('test-provider', response))
      .rejects.toThrow(/Provider test-provider server error \(500\): plain text error/);
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
