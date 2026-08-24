import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMContextExceededError } from '../../../src/foundation/llm-provider/index.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

const legacyCallerSources = [
  '../../../tests/daemon/error-handlers.test.ts',
  '../../../tests/daemon/daemon-loop.test.ts',
  '../../../tests/core/event-loop/event-loop.test.ts',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));

describe('LLMContextExceededError owner boundary', () => {
  it('is owned by LLMProvider and absent from the Orchestrator deep surface', () => {
    expect(typeof LLMContextExceededError).toBe('function');
    expect('LLMContextExceededError' in orchestratorErrors).toBe(false);
  });

  it('has no legacy test caller and remains an Orchestrator classification input', () => {
    for (const source of legacyCallerSources) {
      expect(source).not.toContain('foundation/llm-orchestrator/errors.js');
    }
    const error = new LLMContextExceededError('test-provider', 400, 'prompt is too long');
    expect(orchestratorErrors.classifyLLMError(error)).toBe('context_exceeded');
    expect(orchestratorErrors.isContextExceededError(error)).toBe(true);
  });
});
