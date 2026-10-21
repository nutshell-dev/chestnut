import { describe, it, expect } from 'vitest';
import {
  classifyLLMError,
  isContextExceededError,
  LLMAllProvidersFailedError,
} from '../../src/foundation/llm-orchestrator/index.js';
import {
  LLMContextExceededError,
  LLMError,
  LLMNetworkError,
  LLMOutputBudgetExceededError,
  LLMRateLimitError,
} from '../../src/foundation/llm-provider/index.js';

describe('isContextExceededError（Phase 1960 typed 消费谓词）', () => {
  it('returns true for LLMContextExceededError (instanceof)', () => {
    const err = new LLMContextExceededError('test-provider', 400, 'max context exceeded');
    expect(isContextExceededError(err)).toBe(true);
  });

  it('returns true for LLMOutputBudgetExceededError (instanceof)', () => {
    const err = new LLMOutputBudgetExceededError('test-provider', 8192, 8000, 9000, 'budget');
    expect(isContextExceededError(err)).toBe(true);
  });

  it('returns true when aggregate contains a context sub-error', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'p1', error: new LLMNetworkError('p1', new Error('ECONNRESET')) },
      { provider: 'p2', error: new LLMContextExceededError('p2', 400, 'prompt is too long') },
    ]);
    expect(isContextExceededError(err)).toBe(true);
  });

  it('recurses into nested aggregates', () => {
    const nested = new LLMAllProvidersFailedError([
      { provider: 'p1', error: new LLMOutputBudgetExceededError('p1', 8192, 8000, 9000, 'budget') },
    ]);
    const err = new LLMAllProvidersFailedError([{ provider: 'p0', error: nested }]);
    expect(isContextExceededError(err)).toBe(true);
  });

  it('returns false for aggregate without context sub-errors', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'p1', error: new LLMNetworkError('p1', new Error('Network timeout')) },
      { provider: 'p2', error: new LLMRateLimitError('p2', 3) },
    ]);
    expect(isContextExceededError(err)).toBe(false);
  });

  it('returns false for plain Error carrying provider context text (boundary tightening)', () => {
    expect(isContextExceededError(new Error("This model's maximum context length is 1048565 tokens"))).toBe(false);
    expect(isContextExceededError(new Error('Please reduce the length of the messages or completion.'))).toBe(false);
    expect(isContextExceededError(new Error('LLM context exceeded for deepseek-v4pro (HTTP 400): too many tokens'))).toBe(false);
  });

  it('returns false for LLMError without typed context class', () => {
    const err = new LLMError(
      'All 3 providers exhausted with context_window_exceeded. Reduce system prompt.',
      { totalAttempted: 3 },
    );
    expect(isContextExceededError(err)).toBe(false);
  });

  it('returns false for non-Error', () => {
    expect(isContextExceededError('string error')).toBe(false);
    expect(isContextExceededError(null)).toBe(false);
    expect(isContextExceededError(undefined)).toBe(false);
    expect(isContextExceededError({ message: 'context exceeded' })).toBe(false);
  });
});

describe('classifyLLMError aggregate ordering（不改策略）', () => {
  it('transient 仍优先于 context_exceeded', () => {
    const err = new LLMAllProvidersFailedError([
      { provider: 'p1', error: new LLMContextExceededError('p1', 400, 'prompt is too long') },
      { provider: 'p2', error: new LLMNetworkError('p2', new Error('ECONNRESET')) },
    ]);
    expect(classifyLLMError(err)).toBe('transient');
  });

  it('单 provider typed context → context_exceeded', () => {
    expect(classifyLLMError(new LLMContextExceededError('p1', 400, 'x'))).toBe('context_exceeded');
    expect(classifyLLMError(new LLMOutputBudgetExceededError('p1', 1, 1, 1, 'x'))).toBe('context_exceeded');
  });
});
