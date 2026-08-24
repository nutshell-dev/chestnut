import { describe, expect, it } from 'vitest';
import { LLMOutputBudgetExceededError } from '../../../src/foundation/llm-provider/index.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

describe('LLMOutputBudgetExceededError owner boundary', () => {
  it('is owned by LLMProvider and absent from the Orchestrator deep surface', () => {
    expect(typeof LLMOutputBudgetExceededError).toBe('function');
    expect('LLMOutputBudgetExceededError' in orchestratorErrors).toBe(false);
  });

  it('remains an Orchestrator context_exceeded classification input', () => {
    const error = new LLMOutputBudgetExceededError(
      'test-provider',
      200_000,
      190_000,
      20_000,
      'requested output exceeds the provider context budget',
    );
    expect(orchestratorErrors.classifyLLMError(error)).toBe('context_exceeded');
  });
});
