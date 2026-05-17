/**
 * AgentExecutor wall-time cap — reverse test for phase 903 B4
 *
 * When wallTimeDeadlineMs is exceeded, WallTimeExceededError must be thrown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runReact } from '../../../src/core/agent-executor/index.js';
import { WallTimeExceededError } from '../../../src/types/errors.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { IToolExecutor } from '../../../src/foundation/tools/executor.js';
import { makeExecContext } from '../../helpers/exec-context.js';

function makeSlowLLM(): LLMOrchestrator {
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

describe('AgentExecutor wall-time cap (phase 903 B4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws WallTimeExceededError when deadline exceeded', async () => {
    const llm = makeSlowLLM();

    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 6000;
      return now;
    });

    await expect(
      runReact({
        messages: [],
        systemPrompt: '',
        llm,
        tools: [],
        executor: makeNoopExecutor(),
        ctx: makeExecContext(),
        wallTimeDeadlineMs: 5000,
        maxSteps: 10000,
      }),
    ).rejects.toThrow(WallTimeExceededError);
  });

  it('does not throw when deadline is not exceeded', async () => {
    const llm = makeSlowLLM();

    // Make the LLM return final on first call to avoid infinite loop
    (llm.stream as any).mockImplementation(async function* () {
      yield { type: 'text_delta', delta: 'done' };
      yield { type: 'done', stopReason: 'end_turn' };
    });

    const result = await runReact({
      messages: [],
      systemPrompt: '',
      llm,
      tools: [],
      executor: makeNoopExecutor(),
      ctx: makeExecContext(),
      wallTimeDeadlineMs: 5000,
    });

    expect(result).toMatchObject({
      finalText: 'done',
      stopReason: 'end_turn',
    });
  });
});
