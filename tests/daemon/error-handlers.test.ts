import { describe, it, expect } from 'vitest';
import {
  isContextExceededError,
  LLMContextExceededError,
  LLMAllProvidersFailedError,
} from '../../src/foundation/llm-orchestrator/index.js';
import { LLMError } from '../../src/foundation/llm-provider/errors.js';

describe('isContextExceededError', () => {
  it('returns true for LLMContextExceededError (instanceof)', () => {
    const err = new LLMContextExceededError('test-provider', 400, 'max context exceeded');
    expect(isContextExceededError(err)).toBe(true);
  });

  it('returns true for LLMError with context_window_exceeded message (regex)', () => {
    const err = new LLMError(
      'All 3 providers exhausted with context_window_exceeded. Reduce system prompt.',
      { totalAttempted: 3 },
    );
    expect(isContextExceededError(err)).toBe(true);
  });

  it('returns true for regular Error with "maximum context length" in message', () => {
    const err = new Error("This model's maximum context length is 1048565 tokens");
    expect(isContextExceededError(err)).toBe(true);
  });

  it('returns true for Error with "reduce the length of" in message', () => {
    const err = new Error('Please reduce the length of the messages or completion.');
    expect(isContextExceededError(err)).toBe(true);
  });

  it('returns true for Error with "context exceeded" in message', () => {
    const err = new Error('LLM context exceeded for deepseek-v4pro (HTTP 400): too many tokens');
    expect(isContextExceededError(err)).toBe(true);
  });

  it('returns false for LLMAllProvidersFailedError without context_exceeded sub-messages', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'p1', error: new Error('Network timeout') },
      { provider: 'p2', error: new Error('Rate limited') },
    ]);
    expect(isContextExceededError(err)).toBe(false);
  });

  it('returns false for regular Error', () => {
    expect(isContextExceededError(new Error('something went wrong'))).toBe(false);
  });

  it('returns false for non-Error', () => {
    expect(isContextExceededError('string error')).toBe(false);
    expect(isContextExceededError(null)).toBe(false);
    expect(isContextExceededError(undefined)).toBe(false);
    expect(isContextExceededError({ message: 'context exceeded' })).toBe(false);
  });
});
