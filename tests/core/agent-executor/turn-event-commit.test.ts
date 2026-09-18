/**
 * Phase 283: turn-event-commit typed function tests.
 *
 * Anchor: phase 227 invariants → by-construction equal via single commit function.
 */

import { describe, it, expect, vi } from 'vitest';
import { commitTurnEvent } from '../../../src/core/agent-executor/turn-event-commit.js';
// phase 1856 (AE-D7): 公共导入编译断言 —— TurnEvent 自 barrel 可导入（公共签名完整）
import type { TurnEvent } from '../../../src/core/agent-executor/index.js';
import { runReact } from '../../../src/core/agent-executor/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { IToolExecutor } from '../../../src/foundation/tools/executor.js';
import { makeExecContext } from '../../helpers/exec-context.js';

describe('commitTurnEvent', () => {
  it('text_end 调用 onTextEnd', () => {
    const onTextEnd = vi.fn();
    commitTurnEvent({ kind: 'text_end' }, { onTextEnd });
    expect(onTextEnd).toHaveBeenCalledTimes(1);
  });

  it('tool_call 调用 onToolCall 并传参', () => {
    const onToolCall = vi.fn();
    commitTurnEvent({ kind: 'tool_call', name: 'read', toolUseId: 'tu-1' }, { onToolCall });
    expect(onToolCall).toHaveBeenCalledWith('read', 'tu-1');
  });

  it('tool_result 调用 onToolResult 并传参', () => {
    const onToolResult = vi.fn();
    const result = { success: true, content: 'ok' };
    commitTurnEvent({ kind: 'tool_result', name: 'read', toolUseId: 'tu-1', result, step: 2, maxSteps: 10 }, { onToolResult });
    expect(onToolResult).toHaveBeenCalledWith('read', 'tu-1', result, 2, 10);
  });

  it('phase 1856 (AE-D7): TurnEvent 自 barrel 导入可标注事件（公共签名完整）', () => {
    const event: TurnEvent = { kind: 'tool_call', name: 'read', toolUseId: 'tu-1' };
    const onToolCall = vi.fn();
    commitTurnEvent(event, { onToolCall });
    expect(onToolCall).toHaveBeenCalledWith('read', 'tu-1');
  });

  it('缺少 callback 时不抛错', () => {
    expect(() => commitTurnEvent({ kind: 'text_end' }, {})).not.toThrow();
    expect(() => commitTurnEvent({ kind: 'tool_call', name: 'read', toolUseId: 'tu-1' }, {})).not.toThrow();
    expect(() => commitTurnEvent({ kind: 'tool_result', name: 'read', toolUseId: 'tu-1', result: { success: true, content: 'ok' }, step: 1, maxSteps: 5 }, {})).not.toThrow();
  });
});

/**
 * phase 1856 AE-D1: streamCallbacks 组合而非覆盖。
 * caller 经 stepCallbacks（runReact 平铺回调）传入的同名 handler 不再被静默丢弃；
 * AgentExecutor-owned turn event commit 先行，caller handler 随后。
 */
describe('streamCallbacks 组合而非覆盖（phase 1856 AE-D1）', () => {
  function makeTwoStepLLM(): LLMOrchestrator {
    let calls = 0;
    async function* toolUseStream(): AsyncIterableIterator<unknown> {
      yield { type: 'tool_use_start', toolUse: { id: 't1', name: 'noop', partialInput: '' } };
      yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } };
      yield { type: 'done', stopReason: 'tool_use' };
    }
    async function* textStream(): AsyncIterableIterator<unknown> {
      yield { type: 'text_delta', delta: 'done' };
      yield { type: 'done', stopReason: 'end_turn' };
    }
    return {
      call: vi.fn(),
      stream: vi.fn(() => (calls++ === 0 ? toolUseStream() : textStream())),
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

  it('预置 stepCallbacks 同名 handler + 提供 streamCallbacks → 两侧均调用、commit 先行', async () => {
    const caller = { onTextEnd: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn() };
    const sink = { onTextEnd: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn() };

    const result = await runReact({
      messages: [],
      systemPrompt: '',
      llm: makeTwoStepLLM(),
      tools: [],
      executor: makeNoopExecutor(),
      ctx: makeExecContext(),
      stepCallbacks: {
        onTextEnd: caller.onTextEnd,
        onToolCall: caller.onToolCall,
        onToolResult: caller.onToolResult,
      },
      streamCallbacks: sink,
    });

    expect(result.finalText).toBe('done');
    // 两侧均被调用（caller handler 不被覆盖丢弃）
    expect(sink.onTextEnd).toHaveBeenCalled();
    expect(caller.onTextEnd).toHaveBeenCalled();
    expect(sink.onToolCall).toHaveBeenCalledWith('noop', 't1');
    expect(caller.onToolCall).toHaveBeenCalledWith('noop', 't1');
    expect(sink.onToolResult).toHaveBeenCalled();
    expect(caller.onToolResult).toHaveBeenCalled();
    // commit（sink）先行，caller handler 随后
    expect(sink.onTextEnd.mock.invocationCallOrder[0]).toBeLessThan(caller.onTextEnd.mock.invocationCallOrder[0]);
    expect(sink.onToolCall.mock.invocationCallOrder[0]).toBeLessThan(caller.onToolCall.mock.invocationCallOrder[0]);
    expect(sink.onToolResult.mock.invocationCallOrder[0]).toBeLessThan(caller.onToolResult.mock.invocationCallOrder[0]);
  });

  it('不提供 streamCallbacks → caller handler 照旧调用（行为与今前一致）', async () => {
    const caller = { onTextEnd: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn() };

    const result = await runReact({
      messages: [],
      systemPrompt: '',
      llm: makeTwoStepLLM(),
      tools: [],
      executor: makeNoopExecutor(),
      ctx: makeExecContext(),
      stepCallbacks: {
        onTextEnd: caller.onTextEnd,
        onToolCall: caller.onToolCall,
        onToolResult: caller.onToolResult,
      },
    });

    expect(result.finalText).toBe('done');
    expect(caller.onTextEnd).toHaveBeenCalled();
    expect(caller.onToolCall).toHaveBeenCalledWith('noop', 't1');
    expect(caller.onToolResult).toHaveBeenCalled();
  });
});
