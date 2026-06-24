/**
 * Phase 1157 — llm-provider/errors.ts dedicated unit test
 *
 * 覆盖: 7 LLM error class × code + payload + message + super inheritance invariant
 */
import { describe, it, expect } from 'vitest';
import {
  LLMError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMAuthError,
  LLMNetworkError,
  LLMEmptyResponseError,
  LLMModelNotFoundError,
} from '../../../src/foundation/llm-provider/errors.js';

describe('llm-provider/errors — LLM error class hierarchy (phase 1157)', () => {
  describe('LLMError (base)', () => {
    it('code invariant === LLM_CALL_FAILED', () => {
      const e = new LLMError('test');
      expect(e.code).toBe('LLM_CALL_FAILED');
    });

    it('inherits Error', () => {
      const e = new LLMError('test');
      expect(e).toBeInstanceOf(Error);
    });
  });

  describe('LLMRateLimitError', () => {
    it('code + retryAfter + message + inheritance', () => {
      const e = new LLMRateLimitError('openai', 60);
      expect(e.code).toBe('LLM_RATE_LIMITED');
      expect(e.retryAfter).toBe(60);
      expect(e.message).toContain('openai');
      expect(e.message).toContain('Rate limited');
      expect(e).toBeInstanceOf(LLMError);
      expect(e).toBeInstanceOf(Error);
    });

    it('retryAfter undefined when omitted', () => {
      const e = new LLMRateLimitError('anthropic');
      expect(e.retryAfter).toBeUndefined();
      expect(e.code).toBe('LLM_RATE_LIMITED');
    });

    it('toJSON includes code, message, context with provider and retryAfter', () => {
      const e = new LLMRateLimitError('openai', 60);
      const json = e.toJSON();
      expect(json.code).toBe('LLM_RATE_LIMITED');
      expect(json.message).toContain('openai');
      expect(json.context).toMatchObject({ provider: 'openai', retryAfter: 60 });
    });
  });

  describe('LLMTimeoutError', () => {
    it('code + timeoutMs + message + inheritance', () => {
      const e = new LLMTimeoutError('gemini', 30000);
      expect(e.code).toBe('LLM_TIMEOUT');
      expect(e.timeoutMs).toBe(30000);
      expect(e.message).toContain('gemini');
      expect(e.message).toContain('30000ms');
      expect(e).toBeInstanceOf(LLMError);
      expect(e).toBeInstanceOf(Error);
    });
  });

  describe('LLMAuthError', () => {
    it('code + statusCode + message + inheritance', () => {
      const e = new LLMAuthError('openai', 401);
      expect(e.code).toBe('LLM_AUTH_FAILED');
      expect(e.message).toContain('openai');
      expect(e.message).toContain('401');
      expect(e).toBeInstanceOf(LLMError);
      expect(e).toBeInstanceOf(Error);
    });

    it('custom message overrides default', () => {
      const e = new LLMAuthError('anthropic', 403, 'Custom auth failure');
      expect(e.message).toBe('Custom auth failure');
      expect(e.code).toBe('LLM_AUTH_FAILED');
    });
  });

  describe('LLMNetworkError', () => {
    it('code + cause + message + inheritance', () => {
      const cause = new Error('ECONNRESET');
      const e = new LLMNetworkError('gemini', cause);
      expect(e.code).toBe('LLM_NETWORK_FAILED');
      expect(e.message).toContain('gemini');
      expect(e.message).toContain('ECONNRESET');
      expect(e.cause).toBe(cause);
      expect(e).toBeInstanceOf(LLMError);
      expect(e).toBeInstanceOf(Error);
    });

    it('toJSON includes cause format', () => {
      const cause = new Error('ECONNRESET');
      const e = new LLMNetworkError('gemini', cause);
      const json = e.toJSON();
      expect(json.code).toBe('LLM_NETWORK_FAILED');
      expect(json.cause).toBeDefined();
      expect(json.context).toMatchObject({ provider: 'gemini' });
    });

    it('works without cause', () => {
      const e = new LLMNetworkError('openai');
      expect(e.code).toBe('LLM_NETWORK_FAILED');
      expect(e.cause).toBeUndefined();
      expect(e.message).not.toContain(':');
    });
  });

  describe('LLMEmptyResponseError', () => {
    it('code + message + inheritance', () => {
      const e = new LLMEmptyResponseError('anthropic');
      expect(e.code).toBe('LLM_EMPTY_RESPONSE');
      expect(e.message).toContain('anthropic');
      expect(e.message).toContain('empty response');
      expect(e).toBeInstanceOf(LLMError);
      expect(e).toBeInstanceOf(Error);
    });

    it('toJSON includes provider in context', () => {
      const e = new LLMEmptyResponseError('anthropic');
      const json = e.toJSON();
      expect(json.code).toBe('LLM_EMPTY_RESPONSE');
      expect(json.context).toMatchObject({ provider: 'anthropic' });
    });
  });

  describe('LLMModelNotFoundError', () => {
    it('code + model + message + inheritance', () => {
      const e = new LLMModelNotFoundError('openai', 'gpt-99');
      expect(e.code).toBe('LLM_MODEL_NOT_FOUND');
      expect(e.message).toContain('openai');
      expect(e.message).toContain('gpt-99');
      expect(e.message).toContain('404');
      expect(e).toBeInstanceOf(LLMError);
      expect(e).toBeInstanceOf(Error);
    });
  });
});
