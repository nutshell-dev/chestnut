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

  it('is consumed by the recovery owner and remains permanent', () => {
    // Phase 1826: provider 类错误的消费方是 LLMOrchestrator（恢复 owner）；
    // EventLoop 不再消费/导入该类（provider 类阻断不再归 EventLoop）。
    expect(eventLoopSource).not.toMatch(/LLMInvalidRequestError/);
    expect(eventLoopTestSource).not.toMatch(/LLMInvalidRequestError/);
    const error = new LLMInvalidRequestError('openai', 'invalid_unicode');
    expect(orchestratorErrors.classifyLLMError(error)).toBe('permanent');
  });
});
