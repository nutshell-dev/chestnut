/**
 * AgentExecutor maxSteps fallback — reverse test for phase 883 B3
 *
 * When caller omits maxSteps, the fallback must be DEFAULT_MAX_STEPS (1000)
 * not the stale 20.
 */

import { describe, it, expect, vi } from 'vitest';
import { runReact } from '../../../src/core/agent-executor/index.js';
import { MaxStepsExceededError } from '../../../src/core/agent-executor/errors.js';
import { DEFAULT_MAX_STEPS } from '../../../src/core/agent-executor/defaults.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { LLMResponse } from '../../../src/foundation/llm-provider/types.js';
import type { IToolExecutor } from '../../../src/foundation/tools/executor.js';
import { makeExecContext } from '../../helpers/exec-context.js';

function makeInfiniteToolUseLLM(): LLMOrchestrator {
  async function* stream(): AsyncIterableIterator<any> {
    yield {
      type: 'tool_use_start',
      toolUse: { id: 't1', name: 'noop', partialInput: '' },
    };
    yield {
      type: 'tool_use_delta',
      toolUse: { id: '', name: '', partialInput: '{}' },
    };
    yield { type: 'done', stopReason: 'tool_use' };
  }
  return {
    call: vi.fn(),
    stream: vi.fn(() => stream()),
    healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
    close: vi.fn(),
  } as unknown as LLMOrchestrator;
}

function makeNoopExecutor(): IToolExecutor {
  return {
    execute: vi.fn(async () => ({ success: true, content: 'ok' })),
    executeParallel: vi.fn(),
    validateArgs: vi.fn(),
  } as unknown as IToolExecutor;
}

describe('AgentExecutor maxSteps fallback (phase 883 B3)', () => {
  it('omitted maxSteps falls back to DEFAULT_MAX_STEPS (1000)', async () => {
    const llm = makeInfiniteToolUseLLM();

    await expect(
      runReact({
        messages: [],
        systemPrompt: '',
        llm,
        tools: [],
        executor: makeNoopExecutor(),
        ctx: makeExecContext(),
        // intentionally omit maxSteps
      }),
    ).rejects.toThrow(MaxStepsExceededError);

    // LLM stream called DEFAULT_MAX_STEPS times (one per step)
    expect(llm.stream).toHaveBeenCalledTimes(DEFAULT_MAX_STEPS);
  });
});
