import { describe, it, expect, vi } from 'vitest';
import {
  collectStreamResponse,
  createStreamState,
  finalizeContent,
  flushToolUse,
} from '../../../src/core/step-executor/llm-stream-collector.js';
import type { StepCallbacks } from '../../../src/core/step-executor/types.js';
import {
  LLMAllProvidersFailedError,
  LLMTimeoutError,
} from '../../../src/foundation/llm-orchestrator/index.js';
import type {
  LLMCallOptions,
  LLMOrchestrator,
} from '../../../src/foundation/llm-orchestrator/index.js';
import type {
  LLMResponse,
  StreamChunk,
} from '../../../src/foundation/llm-provider/index.js';

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

describe('step-executor — stream parseError pair invariant (phase 1282)', () => {
  it('flushToolUse: parseError 时 emit tool_use + tool_result 双块，同 tool_use_id', () => {
    const state = createStreamState();
    state.currentToolUse = { id: 'call-x', name: 'write', input: '{"content":"partial' };

    flushToolUse(state);

    expect(state.contentBlocks).toHaveLength(2);
    expect(state.contentBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'call-x',
      name: 'write',
      input: {},
    });
    expect(state.contentBlocks[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call-x',
      content: expect.stringContaining('Tool input JSON parse failed for "write"'),
      is_error: true,
    });
  });

  it('finalizeContent: parseError 时 emit tool_use + tool_result 双块，同 tool_use_id', () => {
    const state = createStreamState();
    state.currentToolUse = { id: 'call-y', name: 'read', input: '{"path":"/x' };

    finalizeContent(state);

    expect(state.contentBlocks).toHaveLength(2);
    expect(state.contentBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'call-y',
      name: 'read',
      input: {},
    });
    expect(state.contentBlocks[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call-y',
      content: expect.stringContaining('Tool input JSON parse failed for "read"'),
      is_error: true,
    });
    expect(state.currentToolUse).toBeNull();
  });

  it('flushToolUse: parseError 时触发 onToolInputParseError callback', () => {
    const state = createStreamState();
    state.currentToolUse = { id: 'call-z', name: 'edit', input: '{bad' };
    const onToolInputParseError = vi.fn();
    const callbacks: StepCallbacks = {
      onUnparseableToolUse: () => {},
      onToolInputParseError,
    };

    flushToolUse(state, callbacks);

    expect(onToolInputParseError).toHaveBeenCalledTimes(1);
    expect(onToolInputParseError).toHaveBeenCalledWith('edit', 'call-z', '{bad');
  });

  it('flushToolUse: 成功 parse 路径只 emit 1 个 tool_use 块，无 tool_result', () => {
    const state = createStreamState();
    state.currentToolUse = { id: 'call-ok', name: 'read', input: '{"path":"file.txt"}' };

    flushToolUse(state);

    expect(state.contentBlocks).toHaveLength(1);
    expect(state.contentBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'call-ok',
      name: 'read',
      input: { path: 'file.txt' },
    });
  });

  it('finalizeContent: 成功 parse 路径只 emit 1 个 tool_use 块，无 tool_result，并清空 currentToolUse', () => {
    const state = createStreamState();
    state.currentToolUse = { id: 'call-ok2', name: 'write', input: '{"content":"hi"}' };

    finalizeContent(state);

    expect(state.contentBlocks).toHaveLength(1);
    expect(state.contentBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'call-ok2',
      name: 'write',
      input: { content: 'hi' },
    });
    expect(state.currentToolUse).toBeNull();
  });
});

