import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LLMInvalidRequestError } from '../../../src/foundation/llm-provider/index.js';
import * as orchestratorBarrel from '../../../src/foundation/llm-orchestrator/index.js';
import * as orchestratorErrors from '../../../src/foundation/llm-orchestrator/errors.js';

const eventLoopSource = readFileSync(
  new URL('../../../src/core/event-loop/event-loop.ts', import.meta.url),
  'utf8',
);
const eventLoopTestSource = readFileSync(
  new URL('../../../tests/core/event-loop/event-loop.test.ts', import.meta.url),
  'utf8',
);

describe('LLMInvalidRequestError owner boundary', () => {
  it('is owned by LLMProvider and absent from both Orchestrator surfaces', () => {
    expect(typeof LLMInvalidRequestError).toBe('function');
    expect('LLMInvalidRequestError' in orchestratorBarrel).toBe(false);
    expect('LLMInvalidRequestError' in orchestratorErrors).toBe(false);
  });

  it('is consumed from owner by EventLoop and remains permanent', () => {
    for (const source of [eventLoopSource, eventLoopTestSource]) {
      expect(source).toMatch(
        /import\s*\{[^}]*LLMInvalidRequestError[^}]*\}\s*from\s*['"][^'"]*foundation\/llm-provider\/index\.js['"]/s,
      );
    }
    const error = new LLMInvalidRequestError('openai', 'invalid_unicode');
    expect(orchestratorErrors.classifyLLMError(error)).toBe('permanent');
  });
});
