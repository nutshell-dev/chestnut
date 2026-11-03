import { describe, it, expect } from 'vitest';
import {
  LLMError,
  LLMAuthError,
  LLMContextExceededError,
  LLMInvalidRequestError,
  LLMModelNotFoundError,
  LLMNetworkError,
  LLMQuotaError,
  LLMRateLimitError,
  LLMTimeoutError,
  makeExternalAbortError,
} from '../../src/foundation/llm-provider/index.js';
import {
  classifyLLMError,
  getUserActionHint,
} from '../../src/foundation/llm-orchestrator/index.js';
import { classifyLLMErrorForDisplay } from '../../src/cli/llm-connection-check.js';

describe('classifyLLMErrorForDisplay', () => {
  it.each([
    {
      name: 'auth', error: new LLMAuthError('p', 401),
      ownerClass: 'permanent', hint: 'rotate_api_key', display: 'auth',
    },
    {
      name: 'model', error: new LLMModelNotFoundError('p', 'missing'),
      ownerClass: 'permanent', hint: 'switch_primary', display: 'model',
    },
    {
      name: 'rate limit', error: new LLMRateLimitError('p'),
      ownerClass: 'rate_limit', hint: 'wait_retry_after', display: 'rate_limit',
    },
    {
      name: 'quota', error: new LLMQuotaError('p', 'quota exceeded'),
      ownerClass: 'quota', hint: 'check_quota', display: 'quota',
    },
    {
      name: 'timeout', error: new LLMTimeoutError('p', 60_000),
      ownerClass: 'transient', hint: 'check_endpoint', display: 'network',
    },
    {
      name: 'network', error: new LLMNetworkError('p', new Error('ECONNRESET')),
      ownerClass: 'transient', hint: 'check_network', display: 'network',
    },
    {
      name: 'transient without hint', error: new LLMError('temporary failure'),
      ownerClass: 'transient', hint: null, display: 'network',
    },
  ])('maps typed $name using owner evidence', ({ error, ownerClass, hint, display }) => {
    expect(classifyLLMError(error)).toBe(ownerClass);
    expect(getUserActionHint(error)).toBe(hint);
    expect(classifyLLMErrorForDisplay(error)).toBe(display);
  });

  it.each([
    {
      name: 'plain quota text', error: new Error('quota'),
      ownerClass: 'unknown', hint: null,
    },
    {
      name: 'plain 401 text', error: new Error('401'),
      ownerClass: 'unknown', hint: null,
    },
    {
      name: 'unrecognized error', error: new Error('Something weird happened'),
      ownerClass: 'unknown', hint: null,
    },
    {
      name: 'permanent without hint',
      error: new LLMInvalidRequestError('p', 'provider_json_parse_rejected'),
      ownerClass: 'permanent', hint: null,
    },
    {
      name: 'context exceeded without hint', error: new LLMContextExceededError('p', 400, 'too large'),
      ownerClass: 'context_exceeded', hint: null,
    },
    {
      name: 'abort without hint', error: makeExternalAbortError(),
      ownerClass: 'abort', hint: null,
    },
  ])('maps $name to unknown without text fallback', ({ error, ownerClass, hint }) => {
    expect(classifyLLMError(error)).toBe(ownerClass);
    expect(getUserActionHint(error)).toBe(hint);
    expect(classifyLLMErrorForDisplay(error)).toBe('unknown');
  });
});
