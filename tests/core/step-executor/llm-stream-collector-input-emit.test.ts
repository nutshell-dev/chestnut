import { describe, it, expect, vi } from 'vitest';
import { createStreamState, flushToolUse, finalizeContent, collectStreamResponse } from '../../../src/core/step-executor/llm-stream-collector.js';
import type { StepCallbacks } from '../../../src/core/step-executor/types.js';
import type { StreamChunk, LLMResponse } from '../../../src/core/../foundation/llm-provider/index.js';
import type { LLMOrchestrator, LLMCallOptions } from '../../../src/foundation/llm-orchestrator/index.js';

describe('phase 688: stream.jsonl 落 tool_use input + catch 路径 drain', () => {
  describe('flushToolUse / finalizeContent fire onToolUseInput', () => {
    it('flushToolUse parse 成功 → fire onToolUseInput(name, id, parsed args)', () => {
      const state = createStreamState();
      state.currentToolUse = { id: 'call-1', name: 'exec', input: '{"command":"ls"}' };
      const onToolUseInput = vi.fn();
      const callbacks: StepCallbacks = {
        onUnparseableToolUse: () => {},
        onToolUseInput,
      };

      flushToolUse(state, callbacks);

      expect(onToolUseInput).toHaveBeenCalledTimes(1);
      expect(onToolUseInput).toHaveBeenCalledWith('exec', 'call-1', { command: 'ls' });
      expect(state.currentToolUse).toBeNull();
    });

    it('finalizeContent parse 成功 → fire onToolUseInput(name, id, parsed args)', () => {
      const state = createStreamState();
      state.currentToolUse = { id: 'call-2', name: 'write', input: '{"path":"a.txt","content":"hi"}' };
      const onToolUseInput = vi.fn();
      const callbacks: StepCallbacks = {
        onUnparseableToolUse: () => {},
        onToolUseInput,
      };

      finalizeContent(state, callbacks);

      expect(onToolUseInput).toHaveBeenCalledTimes(1);
      expect(onToolUseInput).toHaveBeenCalledWith('write', 'call-2', { path: 'a.txt', content: 'hi' });
    });

    it('flushToolUse parse 失败 → 不 fire onToolUseInput（占位块走 phase 1282 路径）', () => {
      const state = createStreamState();
      state.currentToolUse = { id: 'call-3', name: 'edit', input: '{bad json' };
      const onToolUseInput = vi.fn();
      const callbacks: StepCallbacks = {
        onUnparseableToolUse: () => {},
        onToolUseInput,
        onToolInputParseError: vi.fn(),
      };

      flushToolUse(state, callbacks);

      expect(onToolUseInput).not.toHaveBeenCalled();
    });

    it('finalizeContent parse 失败 → 不 fire onToolUseInput', () => {
      const state = createStreamState();
      state.currentToolUse = { id: 'call-4', name: 'edit', input: '{partial' };
      const onToolUseInput = vi.fn();
      const callbacks: StepCallbacks = {
        onUnparseableToolUse: () => {},
        onToolUseInput,
        onToolInputParseError: vi.fn(),
      };

      finalizeContent(state, callbacks);

      expect(onToolUseInput).not.toHaveBeenCalled();
    });

    it('flushToolUse 重复调（无 currentToolUse）→ 不 fire 多次', () => {
      const state = createStreamState();
      state.currentToolUse = { id: 'call-5', name: 'read', input: '{"path":"x"}' };
      const onToolUseInput = vi.fn();
      const callbacks: StepCallbacks = {
        onUnparseableToolUse: () => {},
        onToolUseInput,
      };

      flushToolUse(state, callbacks);
      flushToolUse(state, callbacks);

      expect(onToolUseInput).toHaveBeenCalledTimes(1);
    });
  });

  describe('collectStreamResponse catch 路径 drain', () => {
    function makeLLM(chunks: StreamChunk[], throwAfter: number, errToThrow: Error): LLMOrchestrator {
      return {
        async *stream(_opts: LLMCallOptions): AsyncGenerator<StreamChunk> {
          let i = 0;
          for (const c of chunks) {
            if (i >= throwAfter) throw errToThrow;
            yield c;
            i++;
          }
          throw errToThrow;
        },
        async call() { throw new Error('not used'); },
        getProviderInfo() { return { name: 'test', model: 'test', isFallback: false }; },
      } as unknown as LLMOrchestrator;
    }

    it('流式 emit 3 个 tool_use_start + 抛错 → catch drain 让 3 个 input 都 fire（含 in-flight 最后一个）', async () => {
      const chunks: StreamChunk[] = [
        { type: 'tool_use_start', toolUse: { id: 'c1', name: 'exec', partialInput: '' } },
        { type: 'tool_use_delta', toolUse: { id: 'c1', name: 'exec', partialInput: '{"cmd":"a"}' } },
        { type: 'tool_use_start', toolUse: { id: 'c2', name: 'exec', partialInput: '' } },
        { type: 'tool_use_delta', toolUse: { id: 'c2', name: 'exec', partialInput: '{"cmd":"b"}' } },
        { type: 'tool_use_start', toolUse: { id: 'c3', name: 'exec', partialInput: '' } },
        { type: 'tool_use_delta', toolUse: { id: 'c3', name: 'exec', partialInput: '{"cmd":"c"}' } },
      ];
      const err = new Error('LLMAllProvidersFailedError simulated');
      const llm = makeLLM(chunks, 99, err);

      const onToolUseInput = vi.fn();
      const callbacks: StepCallbacks = {
        onUnparseableToolUse: () => {},
        onToolUseInput,
      };

      await expect(collectStreamResponse(llm, {} as LLMCallOptions, callbacks)).rejects.toThrow('LLMAllProvidersFailedError simulated');

      expect(onToolUseInput).toHaveBeenCalledTimes(3);
      expect(onToolUseInput).toHaveBeenNthCalledWith(1, 'exec', 'c1', { cmd: 'a' });
      expect(onToolUseInput).toHaveBeenNthCalledWith(2, 'exec', 'c2', { cmd: 'b' });
      expect(onToolUseInput).toHaveBeenNthCalledWith(3, 'exec', 'c3', { cmd: 'c' });
    });

    it('正常成功路径 → 每个 tool_use 都 fire 一次、不重复', async () => {
      const chunks: StreamChunk[] = [
        { type: 'tool_use_start', toolUse: { id: 'a1', name: 'read', partialInput: '' } },
        { type: 'tool_use_delta', toolUse: { id: 'a1', name: 'read', partialInput: '{"path":"x"}' } },
        { type: 'tool_use_start', toolUse: { id: 'a2', name: 'read', partialInput: '' } },
        { type: 'tool_use_delta', toolUse: { id: 'a2', name: 'read', partialInput: '{"path":"y"}' } },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_use' },
      ];
      // not throw — generator ends naturally
      const llm: LLMOrchestrator = {
        async *stream(_opts: LLMCallOptions): AsyncGenerator<StreamChunk> {
          for (const c of chunks) yield c;
        },
        async call() { throw new Error('not used'); },
        getProviderInfo() { return { name: 'test', model: 'test', isFallback: false }; },
      } as unknown as LLMOrchestrator;

      const onToolUseInput = vi.fn();
      const callbacks: StepCallbacks = {
        onUnparseableToolUse: () => {},
        onToolUseInput,
      };

      const res: LLMResponse = await collectStreamResponse(llm, {} as LLMCallOptions, callbacks);

      expect(onToolUseInput).toHaveBeenCalledTimes(2);
      expect(onToolUseInput).toHaveBeenNthCalledWith(1, 'read', 'a1', { path: 'x' });
      expect(onToolUseInput).toHaveBeenNthCalledWith(2, 'read', 'a2', { path: 'y' });
      expect(res.content.filter(b => b.type === 'tool_use')).toHaveLength(2);
    });

    it('callback throw 不污染原 err（safeCallback 守 + drain best-effort）', async () => {
      const chunks: StreamChunk[] = [
        { type: 'tool_use_start', toolUse: { id: 'b1', name: 'exec', partialInput: '' } },
        { type: 'tool_use_delta', toolUse: { id: 'b1', name: 'exec', partialInput: '{"x":1}' } },
      ];
      const originalErr = new Error('original-orchestrator-err');
      const llm = makeLLM(chunks, 99, originalErr);

      const callbacks: StepCallbacks = {
        onUnparseableToolUse: () => {},
        onToolUseInput: () => { throw new Error('callback-internal-err'); },
        onSafeCallbackError: vi.fn(),
      };

      await expect(collectStreamResponse(llm, {} as LLMCallOptions, callbacks)).rejects.toThrow('original-orchestrator-err');
      // safeCallback 记到 onSafeCallbackError，不重抛出
      expect(callbacks.onSafeCallbackError).toHaveBeenCalled();
    });
  });
});
