import { describe, it, expect } from 'vitest';
import {
  LLMError,
  LLMAuthError,
  LLMModelNotFoundError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMNetworkError,
} from '../../../src/foundation/llm-provider/errors.js';
import { LLMInvalidRequestError } from '../../../src/foundation/llm-provider/request-unicode.js';
import { classifyLLMError, LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/errors.js';

describe('orchestrator classifyLLMError (phase 451 Step C)', () => {
  it('quota keyword in plain Error → permanent', () => {
    expect(classifyLLMError(new Error('quota exceeded'))).toBe('permanent');
  });

  it('insufficient credit keyword → permanent', () => {
    expect(classifyLLMError(new Error('insufficient credit'))).toBe('permanent');
  });

  it('billing keyword → permanent', () => {
    expect(classifyLLMError(new Error('billing issue'))).toBe('permanent');
  });

  it('LLMAuthError without quota keyword → permanent', () => {
    expect(classifyLLMError(new LLMAuthError('anthropic', 401))).toBe('permanent');
  });

  it('LLMModelNotFoundError → permanent', () => {
    expect(classifyLLMError(new LLMModelNotFoundError('anthropic', 'missing'))).toBe('permanent');
  });

  it('LLMRateLimitError → rate_limit', () => {
    expect(classifyLLMError(new LLMRateLimitError('anthropic'))).toBe('rate_limit');
  });

  it('LLMNetworkError → transient', () => {
    expect(classifyLLMError(new LLMNetworkError('openai', new Error('ECONNRESET')))).toBe('transient');
  });

  it('LLMTimeoutError → transient', () => {
    expect(classifyLLMError(new LLMTimeoutError('anthropic', 60_000))).toBe('transient');
  });

  it('base LLMError → transient', () => {
    expect(classifyLLMError(new LLMError('something'))).toBe('transient');
  });

  it('LLMInvalidRequestError → permanent', () => {
    expect(classifyLLMError(new LLMInvalidRequestError('openai', 'invalid_unicode'))).toBe('permanent');
  });

  it('LLMAllProvidersFailedError with all invalid_request → permanent', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMInvalidRequestError('openai', 'invalid_unicode') },
      { provider: 'anthropic', error: new LLMInvalidRequestError('anthropic', 'invalid_unicode') },
    ]);
    expect(classifyLLMError(err)).toBe('permanent');
  });

  it('LLMAllProvidersFailedError mixed permanent+transient → transient', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMInvalidRequestError('openai', 'invalid_unicode') },
      { provider: 'anthropic', error: new LLMNetworkError('anthropic', new Error('timeout')) },
    ]);
    expect(classifyLLMError(err)).toBe('transient');
  });

  it('LLMAllProvidersFailedError all rate_limit → rate_limit', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'openai', error: new LLMRateLimitError('openai') },
      { provider: 'anthropic', error: new LLMRateLimitError('anthropic') },
    ]);
    expect(classifyLLMError(err)).toBe('rate_limit');
  });

  it('unrecognized plain Error → unknown', () => {
    expect(classifyLLMError(new Error('unexpected'))).toBe('unknown');
  });
});
