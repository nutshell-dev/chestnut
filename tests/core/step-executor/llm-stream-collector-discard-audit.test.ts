import { describe, it, expect, vi } from 'vitest';
import { collectStreamResponse } from '../../../src/core/step-executor/llm-stream-collector.js';
import type { StepCallbacks } from '../../../src/core/step-executor/types.js';
import { LLMAllProvidersFailedError, LLMTimeoutError } from '../../../src/foundation/llm-orchestrator/index.js';
import type { StreamChunk } from '../../../src/foundation/llm-provider/index.js';
import type { LLMOrchestrator, LLMCallOptions } from '../../../src/foundation/llm-orchestrator/index.js';

function makeLLM(chunks: StreamChunk[], errToThrow: Error): LLMOrchestrator {
  return {
    async *stream(_opts: LLMCallOptions): AsyncGenerator<StreamChunk> {
      for (const c of chunks) yield c;
      throw errToThrow;
    },
    async call() { throw new Error('not used'); },
    getProviderInfo() { return { name: 'test', model: 'test', isFallback: false }; },
  } as unknown as LLMOrchestrator;
}

describe('phase 688: collector catch 路径 emit onPartialAssistantDiscarded', () => {
  it('LLMAllProvidersFailedError → cause=all_providers_failed + 正确 count/range', async () => {
    const chunks: StreamChunk[] = [
      { type: 'thinking_delta', delta: 'plan' },
      { type: 'tool_use_start', toolUse: { id: 'c1', name: 'exec', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: 'c1', name: 'exec', partialInput: '{"x":1}' } },
      { type: 'tool_use_start', toolUse: { id: 'c2', name: 'exec', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: 'c2', name: 'exec', partialInput: '{"x":2}' } },
    ];
    const err = new LLMAllProvidersFailedError([{ provider: 'p1', error: new Error('fail') }]);
    const llm = makeLLM(chunks, err);

    const onPartialAssistantDiscarded = vi.fn();
    const callbacks: StepCallbacks = {
      onUnparseableToolUse: () => {},
      onPartialAssistantDiscarded,
    };

    await expect(collectStreamResponse(llm, {} as LLMCallOptions, callbacks)).rejects.toBe(err);

    expect(onPartialAssistantDiscarded).toHaveBeenCalledTimes(1);
    const info = onPartialAssistantDiscarded.mock.calls[0]![0]!;
    expect(info.cause).toBe('all_providers_failed');
    expect(info.toolUseCount).toBe(2);
    expect(info.hasText).toBe(false);
    expect(info.hasThinking).toBe(true);
    expect(info.startTs).toBeGreaterThan(0);
    expect(info.endTs).toBeGreaterThanOrEqual(info.startTs);
    expect(info.errMessage).toContain('All LLM providers failed');
  });

  it('LLMTimeoutError → cause=idle_timeout', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text_delta', delta: 'hi' },
      { type: 'tool_use_start', toolUse: { id: 't1', name: 'read', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: 't1', name: 'read', partialInput: '{"path":"a"}' } },
    ];
    const err = new LLMTimeoutError('idle', 60000);
    const llm = makeLLM(chunks, err);

    const onPartialAssistantDiscarded = vi.fn();
    const callbacks: StepCallbacks = {
      onUnparseableToolUse: () => {},
      onPartialAssistantDiscarded,
    };

    await expect(collectStreamResponse(llm, {} as LLMCallOptions, callbacks)).rejects.toBe(err);

    expect(onPartialAssistantDiscarded).toHaveBeenCalledTimes(1);
    const info = onPartialAssistantDiscarded.mock.calls[0]![0]!;
    expect(info.cause).toBe('idle_timeout');
    expect(info.toolUseCount).toBe(1);
    expect(info.hasText).toBe(true);
    expect(info.hasThinking).toBe(false);
  });

  it('其他 error → cause=unknown', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text_delta', delta: 'x' },
    ];
    const err = new Error('weird internal');
    const llm = makeLLM(chunks, err);

    const onPartialAssistantDiscarded = vi.fn();
    const callbacks: StepCallbacks = {
      onUnparseableToolUse: () => {},
      onPartialAssistantDiscarded,
    };

    await expect(collectStreamResponse(llm, {} as LLMCallOptions, callbacks)).rejects.toBe(err);

    const info = onPartialAssistantDiscarded.mock.calls[0]![0]!;
    expect(info.cause).toBe('unknown');
    expect(info.toolUseCount).toBe(0);
    expect(info.hasText).toBe(true);
  });

  it('正常成功路径不 fire onPartialAssistantDiscarded', async () => {
    const chunks: StreamChunk[] = [
      { type: 'tool_use_start', toolUse: { id: 'a', name: 'read', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: 'a', name: 'read', partialInput: '{"path":"x"}' } },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_use' },
    ];
    const llm: LLMOrchestrator = {
      async *stream(_opts: LLMCallOptions): AsyncGenerator<StreamChunk> {
        for (const c of chunks) yield c;
      },
      async call() { throw new Error('not used'); },
      getProviderInfo() { return { name: 'test', model: 'test', isFallback: false }; },
    } as unknown as LLMOrchestrator;

    const onPartialAssistantDiscarded = vi.fn();
    const callbacks: StepCallbacks = {
      onUnparseableToolUse: () => {},
      onPartialAssistantDiscarded,
    };

    await collectStreamResponse(llm, {} as LLMCallOptions, callbacks);

    expect(onPartialAssistantDiscarded).not.toHaveBeenCalled();
  });

  it('0 chunk 收到即抛错（startTs 未 set）→ 不 fire discarded', async () => {
    const err = new Error('immediate fail');
    const llm = makeLLM([], err);

    const onPartialAssistantDiscarded = vi.fn();
    const callbacks: StepCallbacks = {
      onUnparseableToolUse: () => {},
      onPartialAssistantDiscarded,
    };

    await expect(collectStreamResponse(llm, {} as LLMCallOptions, callbacks)).rejects.toBe(err);

    expect(onPartialAssistantDiscarded).not.toHaveBeenCalled();
  });

  it('callback throw 不污染原 err', async () => {
    const chunks: StreamChunk[] = [{ type: 'text_delta', delta: 'a' }];
    const err = new LLMAllProvidersFailedError([{ provider: 'p', error: new Error('boom') }]);
    const llm = makeLLM(chunks, err);

    const onSafeCallbackError = vi.fn();
    const callbacks: StepCallbacks = {
      onUnparseableToolUse: () => {},
      onPartialAssistantDiscarded: () => { throw new Error('audit-throw'); },
      onSafeCallbackError,
    };

    await expect(collectStreamResponse(llm, {} as LLMCallOptions, callbacks)).rejects.toBe(err);
    expect(onSafeCallbackError).toHaveBeenCalled();
  });
});
