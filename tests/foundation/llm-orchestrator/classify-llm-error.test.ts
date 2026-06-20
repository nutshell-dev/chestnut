import { describe, it, expect } from 'vitest';
import {
  LLMError,
  LLMAuthError,
  LLMModelNotFoundError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMNetworkError,
} from '../../../src/foundation/llm-provider/errors.js';
import { classifyLLMError } from '../../../src/foundation/llm-orchestrator/errors.js';

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

  it('unrecognized plain Error → unknown', () => {
    expect(classifyLLMError(new Error('unexpected'))).toBe('unknown');
  });
});
