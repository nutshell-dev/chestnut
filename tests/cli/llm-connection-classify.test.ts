import { describe, it, expect } from 'vitest';
import { classifyLLMError } from '../../src/cli/llm-connection-check.js';

describe('classifyLLMError', () => {
  describe('auth', () => {
    it.each([
      ['401 Unauthorized'],
      ['Unauthorized'],
      ['Invalid API key'],
      ['Authentication failed'],
      // Vendor variants that previously fell through to "unknown":
      ['All LLM providers failed: kimi-k2.6 (Failed to authenticate user, please check your API key and try again.)'],
      ['Failed to authenticate user'],
      ['Please check your API key'],
      ['Authenticating with provider failed'],
    ])('classifies %j as auth', (msg) => {
      expect(classifyLLMError(new Error(msg))).toBe('auth');
    });

    it('auth message containing "quota" is classified as quota (quota takes precedence)', () => {
      expect(classifyLLMError(new Error('401 Unauthorized: quota exceeded'))).toBe('quota');
    });
  });

  describe('model', () => {
    it.each([
      ['404 Not Found'],
      ['Model not found'],
      ['The model gpt-9 is not available'],
    ])('classifies %j as model', (msg) => {
      expect(classifyLLMError(new Error(msg))).toBe('model');
    });
  });

  describe('rate_limit', () => {
    it.each([
      ['429 Too Many Requests'],
      ['Rate limit exceeded'],
    ])('classifies %j as rate_limit', (msg) => {
      expect(classifyLLMError(new Error(msg))).toBe('rate_limit');
    });

    it('quota keyword no longer falls through to rate_limit', () => {
      expect(classifyLLMError(new Error('Quota exceeded'))).toBe('quota');
    });
  });

  describe('quota', () => {
    it.each([
      ['Quota exceeded'],
      ['Insufficient credits'],
      ['Credit balance depleted'],
      ['Billing issue'],
    ])('classifies %j as quota', (msg) => {
      expect(classifyLLMError(new Error(msg))).toBe('quota');
    });
  });

  describe('network', () => {
    it.each([
      ['ECONNREFUSED'],
      ['ENOTFOUND api.example.com'],
      ['fetch failed'],
      ['Request timeout'],
      ['HTTP 503 Service Unavailable'],
      ['502 Bad Gateway'],
      ['Internal server error'],
    ])('classifies %j as network', (msg) => {
      expect(classifyLLMError(new Error(msg))).toBe('network');
    });
  });

  describe('unknown', () => {
    it('classifies messages with no recognized keyword as unknown', () => {
      expect(classifyLLMError(new Error('Something weird happened'))).toBe('unknown');
    });
  });
});
