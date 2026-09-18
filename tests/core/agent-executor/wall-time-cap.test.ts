/**
 * AgentExecutor wall-time cap — reverse test for phase 903 B4
 *
 * When wallTimeBudgetMs is exceeded, WallTimeExceededError must be thrown.
 *
 * phase 1856 (AE-D11): 命名与语义统一为 duration 预算（自 loop 起始计时、
 * 仅每 step 顶部检查——非绝对 deadline 也非硬 wall-time limit）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runReact } from '../../../src/core/agent-executor/index.js';
import { WallTimeExceededError } from '../../../src/core/agent-executor/errors.js';
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

  it('throws WallTimeExceededError when budget exceeded（step 粒度：超预算在该步顶部抛）', async () => {
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
        wallTimeBudgetMs: 5000,
        maxSteps: 10000,
      }),
    ).rejects.toThrow(WallTimeExceededError);
  });

  it('does not throw when budget is not exceeded', async () => {
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
      wallTimeBudgetMs: 5000,
    });

    expect(result).toMatchObject({
      finalText: 'done',
      stopReason: 'end_turn',
    });
  });
});
