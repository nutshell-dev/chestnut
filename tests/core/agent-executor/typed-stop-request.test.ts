/**
 * phase 1856 AE-D10: typed loop stop request/outcome。
 *
 * 修前：ctx.stopRequested（裸 boolean，result-capture 工具请求早停）→ loop 返回
 * 伪造的 stopReason='end_turn'，真实停止原因无承载位置。
 * 修后：返回 stopRequest={ kind: 'result_capture' } + stopReason='unknown'（不再伪造）；
 * 消费方（subagent capture 路径）按 typed 字段识别。
 */

import { describe, it, expect, vi } from 'vitest';
import { runReact } from '../../../src/core/agent-executor/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { IToolExecutor } from '../../../src/foundation/tools/executor.js';
import { makeExecContext } from '../../helpers/exec-context.js';

function makeTextLLM(): LLMOrchestrator {
  async function* stream(): AsyncIterableIterator<unknown> {
    yield { type: 'text_delta', delta: 'hi' };
    yield { type: 'done', stopReason: 'end_turn' };
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

describe('typed loop stop request（phase 1856 AE-D10）', () => {
  it('stopRequested → 返回 typed stopRequest=result_capture 且 stopReason=unknown（不伪造 end_turn）', async () => {
    const ctx = { ...makeExecContext(), stopRequested: true };

    const result = await runReact({
      messages: [],
      systemPrompt: '',
      llm: makeTextLLM(),
      tools: [],
      executor: makeNoopExecutor(),
      ctx,
    });

    expect(result.stopRequest).toEqual({ kind: 'result_capture' });
    expect(result.stopReason).toBe('unknown');
    expect(result.finalText).toBe('');
  });

  it('非 capture 停止路径零变化：无 stopRequest 字段', async () => {
    const result = await runReact({
      messages: [],
      systemPrompt: '',
      llm: makeTextLLM(),
      tools: [],
      executor: makeNoopExecutor(),
      ctx: makeExecContext(),
    });

    expect(result.stopRequest).toBeUndefined();
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('hi');
  });
});
