/**
 * ReAct loop tests
 * 
 * All tests use mock LLM - no real API calls
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runReact } from '../../src/core/agent-executor/loop.js';
import type { Message, ContentBlock, LLMResponse, ToolDefinition } from '../../src/foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import type { ExecContext } from '../../src/foundation/tool-protocol/index.js';
import { makeExecContext } from '../helpers/exec-context.js';
import type { IToolExecutor } from '../../src/foundation/tools/executor.js';
import { MaxStepsExceededError } from '../../src/core/agent-executor/errors.js';

/**
 * Convert LLMResponse to stream chunks for mock
 */
async function* responseToStreamChunks(response: LLMResponse): AsyncIterableIterator<StreamChunk> {
  for (const block of response.content) {
    if (block.type === 'text') {
      yield { type: 'text_delta', delta: (block as { text: string }).text };
    } else if (block.type === 'tool_use') {
      const toolBlock = block as { id: string; name: string; input: unknown };
      yield {
        type: 'tool_use_start',
        toolUse: { id: toolBlock.id, name: toolBlock.name, partialInput: '' },
      };
      yield {
        type: 'tool_use_delta',
        toolUse: { id: '', name: '', partialInput: JSON.stringify(toolBlock.input) },
      };
    }
  }
  yield { type: 'done' };
}

describe('ReAct Loop', () => {
  let mockLLM: LLMOrchestrator;
  let mockExecutor: IToolExecutor;
  let mockCtx: ExecContext;
  let llmCallCount: number;

  beforeEach(() => {
    llmCallCount = 0;
    
    const callMock = vi.fn();
    mockLLM = {
      call: callMock,
      stream: vi.fn((...args: unknown[]) => {
        // 复用 call mock 的返回值，转换为 stream chunks
        const result = callMock(...args);
        if (result instanceof Promise) {
          return (async function* () {
            const response = await result;
            yield* responseToStreamChunks(response as LLMResponse);
          })();
        }
        return responseToStreamChunks(result as LLMResponse);
      }),
      close: vi.fn(),
      healthCheck: vi.fn(),
      getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
    } as unknown as LLMOrchestrator;

    mockExecutor = {
      execute: vi.fn(),
      executeParallel: vi.fn(),
      validateArgs: vi.fn(),
    } as unknown as IToolExecutor;

    mockCtx = makeExecContext({ maxSteps: 100 });
  });

  function createTextResponse(text: string): LLMResponse {
    return {
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    };
  }

  function createToolUseResponse(toolName: string, args: object): LLMResponse {
    return {
      content: [
        { type: 'text', text: `Using ${toolName}...` },
        {
          type: 'tool_use',
          id: `call-${llmCallCount++}`,
          name: toolName,
          input: args,
        },
      ],
      stop_reason: 'tool_use',
    };
  }

  it('should complete single tool call flow', async () => {
    // First call: LLM wants to use a tool
    (mockLLM.call as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'test.txt' }))
      // Second call: LLM returns final answer
      .mockResolvedValueOnce(createTextResponse('File content is "hello"'));

    // Mock tool execution
    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      content: 'hello',
    });

    const messages: Message[] = [{ role: 'user', content: 'Read the file' }];

    const result = await runReact({
      messages,
      systemPrompt: 'You are a helpful assistant',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
    });

    expect(result.finalText).toBe('File content is "hello"');
    expect(result.stepsUsed).toBe(1);
    expect(result.stopReason).toBe('end_turn');
    expect(messages.length).toBeGreaterThan(1); // messages were modified in-place
  });

  it('should handle multi-step tool chain', async () => {
    // LLM requests 3 tools sequentially
    (mockLLM.call as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createToolUseResponse('ls', { path: '.' }))
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'file1.txt' }))
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'file2.txt' }))
      .mockResolvedValueOnce(createTextResponse('Done reading all files'));

    (mockExecutor.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, content: 'file1.txt\nfile2.txt' })
      .mockResolvedValueOnce({ success: true, content: 'content1' })
      .mockResolvedValueOnce({ success: true, content: 'content2' });

    const messages: Message[] = [{ role: 'user', content: 'List and read files' }];

    const result = await runReact({
      messages,
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
    });

    expect(result.stepsUsed).toBe(3);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(3);
  });

  it('should handle no tool call (direct answer)', async () => {
    (mockLLM.call as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      createTextResponse('Hello! How can I help?')
    );

    const messages: Message[] = [{ role: 'user', content: 'Hi' }];

    const result = await runReact({
      messages,
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
    });

    expect(result.finalText).toBe('Hello! How can I help?');
    expect(result.stepsUsed).toBe(0);
    expect(result.stopReason).toBe('end_turn');
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  it('should throw MaxStepsExceededError when limit reached', async () => {
    // LLM always wants to use tools
    (mockLLM.call as ReturnType<typeof vi.fn>).mockResolvedValue(
      createToolUseResponse('read', { path: 'test.txt' })
    );

    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      content: 'content',
    });

    const messages: Message[] = [{ role: 'user', content: 'Do something' }];

    await expect(
      runReact({
        messages,
        systemPrompt: '',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: mockCtx,
        maxSteps: 3,
      })
    ).rejects.toThrow(MaxStepsExceededError);

    expect(mockExecutor.execute).toHaveBeenCalledTimes(3);
  });

  it('should continue loop when tool execution fails', async () => {
    // First tool call fails, second succeeds
    (mockLLM.call as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'bad.txt' }))
      .mockResolvedValueOnce(createTextResponse('File not found, moving on'));

    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      content: 'File not found',
    });

    const messages: Message[] = [{ role: 'user', content: 'Read file' }];

    const result = await runReact({
      messages,
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
    });

    expect(result.finalText).toBe('File not found, moving on');
    // Should have received error result back to LLM
    const lastCall = (mockLLM.call as ReturnType<typeof vi.fn>).mock.lastCall;
    const lastMessages = lastCall?.[0]?.messages as Message[];
    
    // Check that error was passed back to LLM
    expect(lastMessages?.some(m => {
      const content = Array.isArray(m.content) ? m.content : [];
      return content.some((b: ContentBlock) => b.type === 'tool_result' && (b as any).is_error);
    })).toBe(true);
  });

  it('should modify messages in-place', async () => {
    (mockLLM.call as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'test.txt' }))
      .mockResolvedValueOnce(createTextResponse('Done'));

    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      content: 'content',
    });

    const messages: Message[] = [{ role: 'user', content: 'Read' }];
    const initialLength = messages.length;

    await runReact({
      messages,
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
    });

    expect(messages.length).toBeGreaterThan(initialLength);
    // Should have: original user, assistant with tool_use, user with tool_result, final assistant
    expect(messages.length).toBe(4);
  });

  it('should call onToolCallback for each tool execution', async () => {
    (mockLLM.call as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'a.txt' }))
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'b.txt' }))
      .mockResolvedValueOnce(createTextResponse('Done'));

    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      content: 'content',
    });

    const toolCalls: string[] = [];

    await runReact({
      messages: [{ role: 'user', content: 'Read files' }],
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
      onToolCall: (name) => toolCalls.push(name),
    });

    expect(toolCalls).toEqual(['read', 'read']);
  });

  it('should call onStepComplete after each step', async () => {
    (mockLLM.call as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'a.txt' }))
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'b.txt' }))
      .mockResolvedValueOnce(createTextResponse('Done'));

    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      content: 'content',
    });

    let stepCount = 0;

    await runReact({
      messages: [{ role: 'user', content: 'Read files' }],
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
      onStepComplete: async () => {
        stepCount++;
      },
    });

    expect(stepCount).toBe(2); // 2 tool calls
  });

  it('should propagate onStepComplete failure immediately (audit log must succeed)', async () => {
    (mockLLM.call as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'test.txt' }))
      .mockResolvedValueOnce(createTextResponse('Done'));

    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      content: 'content',
    });

    await expect(
      runReact({
        messages: [{ role: 'user', content: 'Read' }],
        systemPrompt: '',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: mockCtx,
        onStepComplete: async () => {
          throw new Error('Save failed');
        },
      })
    ).rejects.toThrow('Save failed');
  });

  // Phase 2 质量审查补充：P0 修复验证 - executor.execute() 抛出异常处理
  it('should catch executor.execute() exception and return error result to LLM', async () => {
    (mockLLM.call as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'test.txt' }))
      .mockResolvedValueOnce(createTextResponse('Tool failed but I continued'));

    // Executor throws exception (P0 fix: should be caught, not crash)
    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Disk full')
    );

    const messages: Message[] = [{ role: 'user', content: 'Read file' }];

    const result = await runReact({
      messages,
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
    });

    // Loop should continue and return final text
    expect(result.finalText).toBe('Tool failed but I continued');
    expect(mockLLM.call).toHaveBeenCalledTimes(2);

    // Check error was passed to LLM with is_error flag
    const lastCall = (mockLLM.call as ReturnType<typeof vi.fn>).mock.lastCall;
    const lastMessages = lastCall?.[0]?.messages as Message[];
    const toolResult = lastMessages?.flatMap(m => 
      Array.isArray(m.content) ? m.content : []
    ).find((b: ContentBlock) => b.type === 'tool_result');

    expect(toolResult).toBeDefined();
    expect((toolResult as any).is_error).toBe(true);
    expect((toolResult as any).content).toContain('Disk full');
  });

  // Phase 36: onStepComplete 失败立即停止（审计日志必须成功）
  it('should propagate save error on first onStepComplete failure (no tolerance)', async () => {
    (mockLLM.call as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createToolUseResponse('read', {}))
      .mockResolvedValueOnce(createTextResponse('done'));

    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, content: '',
    });

    const saveError = new Error('disk full');
    const onStepComplete = vi.fn().mockRejectedValue(saveError);

    await expect(
      runReact({
        messages: [{ role: 'user', content: 'go' }],
        systemPrompt: '',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: mockCtx,
        onStepComplete,
      })
    ).rejects.toThrow('disk full');

    // Fails on first call, not third
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // collectStreamResponse path coverage
  // ============================================================

  it('should invoke onBeforeLLMCall before every LLM call', async () => {
    (mockLLM.call as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createToolUseResponse('read', {}))
      .mockResolvedValueOnce(createTextResponse('Done'));
    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, content: '' });

    let callCount = 0;
    await runReact({
      messages: [{ role: 'user', content: 'Go' }],
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
      onBeforeLLMCall: () => { callCount++; },
    });

    // one before the tool-use call, one before the final answer
    expect(callCount).toBe(2);
  });

  it('should invoke onToolResult after each tool execution', async () => {
    (mockLLM.call as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createToolUseResponse('read', { path: 'a.txt' }))
      .mockResolvedValueOnce(createTextResponse('Done'));
    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, content: 'data' });

    const calls: Array<{ name: string; step: number; maxSteps: number }> = [];
    await runReact({
      messages: [{ role: 'user', content: 'Read' }],
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
      maxSteps: 10,
      onToolResult: (name, _toolUseId, _result, step, maxSteps) => calls.push({ name, step, maxSteps }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read');
    expect(calls[0].step).toBe(0);
    expect(calls[0].maxSteps).toBe(10);
  });

  it('should invoke onTextDelta for each streamed text chunk', async () => {
    // Override stream mock to emit explicit deltas
    (mockLLM.stream as ReturnType<typeof vi.fn>).mockImplementationOnce(async function* () {
      yield { type: 'text_delta', delta: 'Hello' };
      yield { type: 'text_delta', delta: ' world' };
      yield { type: 'done' };
    });

    const deltas: string[] = [];
    await runReact({
      messages: [{ role: 'user', content: 'Hi' }],
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
      onTextDelta: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(['Hello', ' world']);
  });

  it('should invoke onThinkingDelta and include thinking block in assistant content', async () => {
    // Stream: thinking before text → thinking block flushed when text_delta arrives
    (mockLLM.stream as ReturnType<typeof vi.fn>).mockImplementationOnce(async function* () {
      yield { type: 'thinking_delta', delta: 'Let me think...' };
      yield { type: 'text_delta', delta: 'The answer is 42' };
      yield { type: 'done' };
    });

    const thinkingDeltas: string[] = [];
    const messages: Message[] = [{ role: 'user', content: 'What is the answer?' }];

    await runReact({
      messages,
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
      onThinkingDelta: (d) => thinkingDeltas.push(d),
    });

    expect(thinkingDeltas).toEqual(['Let me think...']);

    // Assistant message content should contain a thinking block
    const assistantMsg = messages.find(m => m.role === 'assistant');
    const content = Array.isArray(assistantMsg?.content) ? assistantMsg!.content : [];
    expect(content.some((b: ContentBlock) => b.type === 'thinking')).toBe(true);
  });

  it('should flush thinking block before tool_use when no text in between', async () => {
    // Stream: thinking → tool_use (no text in between)
    (mockLLM.stream as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async function* () {
        yield { type: 'thinking_delta', delta: 'Let me think...' };
        yield { type: 'tool_use_start', toolUse: { id: 'call-1', name: 'read_file', partialInput: '' } };
        yield { type: 'tool_use_delta', toolUse: { id: 'call-1', name: 'read_file', partialInput: '{"path":"a.txt"}' } };
        yield { type: 'done' };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'text_delta', delta: 'Done.' };
        yield { type: 'done' };
      });

    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, content: 'ok' });

    const messages: Message[] = [{ role: 'user', content: 'Read file' }];
    await runReact({
      messages,
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
    });

    // Assistant message content should have thinking block before tool_use
    const assistantMsg = messages.find(m => m.role === 'assistant');
    const content = Array.isArray(assistantMsg?.content) ? assistantMsg!.content : [];
    expect(content[0]?.type).toBe('thinking');
    expect(content[1]?.type).toBe('tool_use');
  });

  it('should carry signature in thinking block flushed before tool_use', async () => {
    // Stream: thinking + signature → tool_use
    (mockLLM.stream as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async function* () {
        yield { type: 'thinking_delta', delta: 'Reasoning...' };
        yield { type: 'thinking_signature', signature: 'sig-abc' };
        yield { type: 'tool_use_start', toolUse: { id: 'call-1', name: 'read_file', partialInput: '' } };
        yield { type: 'tool_use_delta', toolUse: { id: 'call-1', name: 'read_file', partialInput: '{"path":"b.txt"}' } };
        yield { type: 'done' };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'text_delta', delta: 'Done.' };
        yield { type: 'done' };
      });

    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, content: 'ok' });

    const messages: Message[] = [{ role: 'user', content: 'Read file' }];
    await runReact({
      messages,
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
    });

    // Assistant message content should have thinking block with signature before tool_use
    const assistantMsg = messages.find(m => m.role === 'assistant');
    const content = Array.isArray(assistantMsg?.content) ? assistantMsg!.content : [];
    expect(content[0]?.type).toBe('thinking');
    expect((content[0] as { signature?: string }).signature).toBe('sig-abc');
    expect(content[1]?.type).toBe('tool_use');
  });

  it('should handle multiple tool_use blocks in one response (flushes previous tool_use)', async () => {
    // Stream two tool_use blocks back-to-back
    (mockLLM.stream as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async function* () {
        yield { type: 'tool_use_start', toolUse: { id: 'id-1', name: 'read', partialInput: '' } };
        yield { type: 'tool_use_delta', toolUse: { id: 'id-1', name: 'read', partialInput: '{"path":"a.txt"}' } };
        yield { type: 'tool_use_start', toolUse: { id: 'id-2', name: 'search', partialInput: '' } };
        yield { type: 'tool_use_delta', toolUse: { id: 'id-2', name: 'search', partialInput: '{"pattern":"foo"}' } };
        yield { type: 'done' };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'text_delta', delta: 'Done' };
        yield { type: 'done' };
      });

    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, content: 'ok' });

    const messages: Message[] = [{ role: 'user', content: 'Search and read' }];
    await runReact({
      messages,
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
    });

    // executor should have been called twice — once for each tool_use block
    expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
  });

  it('should throw when abort signal is already set before LLM call', async () => {
    const controller = new AbortController();
    controller.abort(); // already aborted

    const ctx = {
      ...mockCtx,
      signal: controller.signal,
    };

    await expect(
      runReact({
        messages: [{ role: 'user', content: 'Go' }],
        systemPrompt: '',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: ctx as ExecContext,
      })
    ).rejects.toThrow('aborted');
  });

  it('should throw when abort signal fires after tool execution', async () => {
    const controller = new AbortController();

    (mockLLM.call as ReturnType<typeof vi.fn>).mockResolvedValue(
      createToolUseResponse('read', {})
    );
    // Abort after the tool executes
    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      controller.abort();
      return { success: true, content: 'ok' };
    });

    const ctx = { ...mockCtx, signal: controller.signal };

    await expect(
      runReact({
        messages: [{ role: 'user', content: 'Go' }],
        systemPrompt: '',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: ctx as ExecContext,
      })
    ).rejects.toThrow('aborted');
  });

  it('should return parse failure to LLM when tool_use delta has invalid JSON', async () => {
    let streamCall = 0;
    mockLLM.stream = vi.fn(() => {
      streamCall++;
      if (streamCall === 1) {
        return (async function* () {
          yield { type: 'tool_use_start', toolUse: { id: 'call-broken', name: 'read', partialInput: '' } };
          yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{broken json' } };
          yield { type: 'done' };
        })();
      }
      return (async function* () {
        yield { type: 'text_delta', delta: 'All done.' };
        yield { type: 'done' };
      })();
    });

    // Tool should NOT be called — parse error is returned directly
    (mockExecutor.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: true, content: 'file content' });

    await runReact({
      messages: [{ role: 'user', content: 'read a file' }],
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
      maxSteps: 5,
    });

    // Tool executor should not have been called with the broken tool
    expect(mockExecutor.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'read' })
    );
  });

  // ─── fix 2: callback exception guards ─────────────────────────────────────
  describe('callback exception guards', () => {
    it('onBeforeLLMCall throwing does not abort runReact', async () => {
      (mockLLM.call as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(createTextResponse('hello'));

      const result = await runReact({
        messages: [{ role: 'user', content: 'hi' }],
        systemPrompt: 'test',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: mockCtx,
        maxSteps: 5,
        onBeforeLLMCall: () => { throw new Error('cb error'); },
      });

      expect(result.finalText).toBe('hello');
    });

    it('onToolCall throwing does not abort runReact', async () => {
      (mockLLM.call as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(createToolUseResponse('read', { path: 'f.txt' }))
        .mockResolvedValueOnce(createTextResponse('done'));
      (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        content: 'file contents',
      });

      const result = await runReact({
        messages: [{ role: 'user', content: 'read a file' }],
        systemPrompt: 'test',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: mockCtx,
        maxSteps: 5,
        onToolCall: () => { throw new Error('cb error'); },
      });

      expect(result.finalText).toBe('done');
    });

    it('onToolResult throwing does not abort runReact', async () => {
      (mockLLM.call as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(createToolUseResponse('read', { path: 'f.txt' }))
        .mockResolvedValueOnce(createTextResponse('done'));
      (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        content: 'file contents',
      });

      const result = await runReact({
        messages: [{ role: 'user', content: 'read a file' }],
        systemPrompt: 'test',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: mockCtx,
        maxSteps: 5,
        onToolResult: () => { throw new Error('cb error'); },
      });

      expect(result.finalText).toBe('done');
    });
  });

  // ============================================================
  // Parallel tool execution via registry
  // ============================================================

  it('should execute readonly sync tools in parallel via executeParallel', async () => {
    // 构造 mock executor，含 executeParallel
    const parallelResults = [
      { success: true, content: 'result A' },
      { success: true, content: 'result B' },
    ];
    const parallelExecutor = {
      execute: vi.fn(),
      executeParallel: vi.fn().mockResolvedValue(parallelResults),
      validateArgs: vi.fn(),
    };

    // registry 标记所有工具为 readonly（非 async）
    const registry = {
      get: vi.fn((_name: string) => ({ readonly: true })),
    };

    // LLM 第一轮：返回 2 个 tool_use；第二轮：end_turn
    let step = 0;
    const llm = {
      stream: async function* () {
        step++;
        if (step === 1) {
          yield { type: 'tool_use_start', toolUse: { id: 'id1', name: 'read' } };
          yield { type: 'tool_use_delta', toolUse: { id: 'id1', name: 'read', partialInput: '{"path":"a.txt"}' } };
          yield { type: 'tool_use_start', toolUse: { id: 'id2', name: 'search' } };
          yield { type: 'tool_use_delta', toolUse: { id: 'id2', name: 'search', partialInput: '{"pattern":"q"}' } };
          yield { type: 'done' };
        } else {
          yield { type: 'text_delta', delta: 'Done with both tools' };
          yield { type: 'done' };
        }
      },
    };

    const messages: Message[] = [{ role: 'user', content: 'search and read' }];
    await runReact({
      messages,
      systemPrompt: '',
      llm: llm as any,
      executor: parallelExecutor as any,
      ctx: mockCtx,
      registry: registry as any,
      maxSteps: 5,
    });

    // executeParallel 被调用一次，含 2 个工具（按原始顺序）
    expect(parallelExecutor.executeParallel).toHaveBeenCalledTimes(1);
    const [batch] = (parallelExecutor.executeParallel as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(batch).toHaveLength(2);
    expect(batch[0].toolName).toBe('read');
    expect(batch[0].args).toEqual({ path: 'a.txt' });
    expect(batch[1].toolName).toBe('search');
    expect(batch[1].args).toEqual({ pattern: 'q' });

    // 顺序 execute 不被调用（全部走并行路径）
    expect(parallelExecutor.execute).not.toHaveBeenCalled();

    // messages 中应有 tool_result user 消息（来自 parallel 结果）
    const toolResultMsg = messages.find(m =>
      Array.isArray(m.content) &&
      (m.content as any[])[0]?.type === 'tool_result'
    );
    expect(toolResultMsg).toBeDefined();
    const results = toolResultMsg!.content as any[];
    expect(results[0].tool_use_id).toBe('id1');
    expect(results[0].content).toBe('result A');
    expect(results[1].tool_use_id).toBe('id2');
    expect(results[1].content).toBe('result B');
  });

  // Step 3: max_tokens stop reason propagation fix
  it('should append truncation notice when stop_reason is max_tokens', async () => {
    // Override stream mock to simulate max_tokens stop
    (mockLLM.stream as ReturnType<typeof vi.fn>).mockImplementationOnce(async function* () {
      yield { type: 'text_delta', delta: 'Partial answer due to token limit' };
      yield { type: 'done', stopReason: 'max_tokens' };
    });

    const messages: Message[] = [{ role: 'user', content: 'Write a very long essay' }];

    const result = await runReact({
      messages,
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
      maxSteps: 5,
    });

    // runReact preserves max_tokens stopReason
    expect(result.stopReason).toBe('max_tokens');
    expect(result.finalText).toContain('Partial answer due to token limit');
    expect(result.finalText).toContain('[Response truncated due to length limit]');
    // messages should have user + assistant appended
    expect(messages).toHaveLength(2);
  });

  describe('consecutive parse error detection', () => {
    /**
     * 生成包含格式错误 JSON 的 tool_use stream（无法通过 JSON.parse）
     */
    function createMalformedToolUseStream(toolName: string, callId: string): AsyncIterableIterator<StreamChunk> {
      return (async function* () {
        yield { type: 'tool_use_start' as const, toolUse: { id: callId, name: toolName, partialInput: '' } };
        yield { type: 'tool_use_delta' as const, toolUse: { id: '', name: '', partialInput: '{bad json' } };
        yield { type: 'done' as const };
      })();
    }

    it('should throw after 3 consecutive parse errors', async () => {
      (mockLLM.stream as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p1'))
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p2'))
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p3'));

      const messages: Message[] = [{ role: 'user', content: 'Write a file' }];

      await expect(runReact({
        messages,
        systemPrompt: '',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: mockCtx,
      })).rejects.toThrow('工具输入 JSON 连续解析失败 3 次');

      // executor.execute should never be called — parse error short-circuits before tool execution
      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('should not throw after only 2 consecutive parse errors', async () => {
      (mockLLM.stream as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p1'))
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p2'))
        .mockImplementationOnce(() => (async function* () {
          yield { type: 'text_delta' as const, delta: 'Giving up, sorry.' };
          yield { type: 'done' as const };
        })());

      const messages: Message[] = [{ role: 'user', content: 'Write a file' }];

      const result = await runReact({
        messages,
        systemPrompt: '',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: mockCtx,
      });

      expect(result.finalText).toBe('Giving up, sorry.');
      expect(result.stopReason).toBe('end_turn');
    });

    it('should reset counter after a successful tool call', async () => {
      (mockLLM.stream as ReturnType<typeof vi.fn>)
        // 2 parse errors
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p1'))
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p2'))
        // 1 successful tool call → resets counter
        .mockImplementationOnce(() => (async function* () {
          yield { type: 'tool_use_start' as const, toolUse: { id: 'call-ok', name: 'read', partialInput: '' } };
          yield { type: 'tool_use_delta' as const, toolUse: { id: '', name: '', partialInput: '{"path":"x.txt"}' } };
          yield { type: 'done' as const };
        })())
        // 2 more parse errors — counter was reset, so still below threshold
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p3'))
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p4'))
        // final text
        .mockImplementationOnce(() => (async function* () {
          yield { type: 'text_delta' as const, delta: 'Done.' };
          yield { type: 'done' as const };
        })());

      (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        content: 'file content',
      });

      const messages: Message[] = [{ role: 'user', content: 'Do stuff' }];

      const result = await runReact({
        messages,
        systemPrompt: '',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: mockCtx,
        maxSteps: 10,
      });

      // Should complete without throwing — counter reset after successful call
      expect(result.finalText).toBe('Done.');
      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    });

    it('should throw with tool name in error message', async () => {
      (mockLLM.stream as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p1'))
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p2'))
        .mockReturnValueOnce(createMalformedToolUseStream('write', 'call-p3'));

      await expect(runReact({
        messages: [{ role: 'user', content: 'test' }],
        systemPrompt: '',
        llm: mockLLM,
        executor: mockExecutor,
        ctx: mockCtx,
      })).rejects.toThrow('write');
    });
  });

  describe('max_tokens handling', () => {
    /**
     * 辅助：生成 max_tokens 截断的 tool_use stream
     */
    function createMaxTokensToolUseStream(toolName: string, callId: string, partialInput: string): AsyncIterableIterator<StreamChunk> {
      return (async function* () {
        yield { type: 'tool_use_start' as const, toolUse: { id: callId, name: toolName, partialInput: '' } };
        yield { type: 'tool_use_delta' as const, toolUse: { id: '', name: '', partialInput: partialInput } };
        yield { type: 'done' as const, stopReason: 'max_tokens' };  // 截断
      })();
    }

    it('should append truncated tool_result and continue loop when max_tokens hits during tool_use', async () => {
      (mockLLM.stream as ReturnType<typeof vi.fn>)
        // 第一次：max_tokens 截断 tool_use（输入不完整 JSON）
        .mockReturnValueOnce(createMaxTokensToolUseStream('write', 'call-trunc', '{"content":"partial"}'))
        // 第二次：LLM 收到截断通知，改为正常结束
        .mockImplementationOnce(() => (async function* () {
          yield { type: 'text_delta' as const, delta: 'OK, will split.' };
          yield { type: 'done' as const };
        })());

      const messages: Message[] = [{ role: 'user', content: 'Write a long file' }];
      const result = await runReact({ messages, systemPrompt: '', llm: mockLLM, executor: mockExecutor, ctx: mockCtx });

      // executor 不应被调用（工具未执行）
      expect(mockExecutor.execute).not.toHaveBeenCalled();
      // LLM 被调用了两次（第一次截断，第二次纠正）
      expect(mockLLM.stream).toHaveBeenCalledTimes(2);
      // 第二次 LLM 调用的 messages 里应含截断 tool_result（is_error）
      const secondCallMessages = (mockLLM.stream as ReturnType<typeof vi.fn>).mock.calls[1][0].messages as Message[];
      const userMsgWithToolResult = secondCallMessages.find((m: Message) => 
        m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')
      );
      const toolResult = (userMsgWithToolResult!.content as any[]).find((b: any) => b.type === 'tool_result');
      expect(toolResult?.is_error).toBe(true);
      expect(toolResult?.content).toMatch(/TRUNCATED|parse failed/);
      expect(result.finalText).toBe('OK, will split.');
    });

    it('should return stopReason=max_tokens immediately when no tool_use in truncated response', async () => {
      (mockLLM.stream as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce((async function* () {
          yield { type: 'text_delta' as const, delta: 'Some partial text' };
          yield { type: 'done' as const, stopReason: 'max_tokens' };
        })());

      const messages: Message[] = [{ role: 'user', content: 'Tell me something long' }];
      const result = await runReact({ messages, systemPrompt: '', llm: mockLLM, executor: mockExecutor, ctx: mockCtx });

      expect(result.stopReason).toBe('max_tokens');
      expect(mockLLM.stream).toHaveBeenCalledTimes(1);
    });

    it('should throw after 3 consecutive max_tokens tool_use truncations', async () => {
      (mockLLM.stream as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(createMaxTokensToolUseStream('write', 'call-trunc-1', '{"content":"partial"}'))
        .mockReturnValueOnce(createMaxTokensToolUseStream('write', 'call-trunc-2', '{"content":"partial"}'))
        .mockReturnValueOnce(createMaxTokensToolUseStream('write', 'call-trunc-3', '{"content":"partial"}'));

      const messages: Message[] = [{ role: 'user', content: 'Write a very long file' }];
      await expect(
        runReact({ messages, systemPrompt: '', llm: mockLLM, executor: mockExecutor, ctx: mockCtx })
      ).rejects.toThrow(/连续.*次.*max_tokens.*截断/);

      expect(mockLLM.stream).toHaveBeenCalledTimes(3);
      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('should reset counter after successful step following max_tokens truncation', async () => {
      const truncStream = () => createMaxTokensToolUseStream('write', 'call-trunc', '{"content":"partial"}');
      (mockLLM.stream as ReturnType<typeof vi.fn>)
        // 第 1 次：max_tokens 截断
        .mockReturnValueOnce(truncStream())
        // 第 2 次：正常 tool_use（read 工具）
        .mockReturnValueOnce((async function* () {
          yield { type: 'tool_use_start' as const, toolUse: { id: 'call-ok', name: 'read', partialInput: '' } };
          yield { type: 'tool_use_delta' as const, toolUse: { id: '', name: '', partialInput: '{"path":"x.txt"}' } };
          yield { type: 'done' as const };
        })())
        // 第 3 次：max_tokens 截断（计数应从 0 重新开始，不应抛错）
        .mockReturnValueOnce(truncStream())
        // 第 4 次：正常结束
        .mockReturnValueOnce((async function* () {
          yield { type: 'text_delta' as const, delta: 'Done.' };
          yield { type: 'done' as const };
        })());

      // Mock executor to return success for the read tool call
      (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        content: 'file content',
      });

      const messages: Message[] = [{ role: 'user', content: 'Do something' }];
      const result = await runReact({ messages, systemPrompt: '', llm: mockLLM, executor: mockExecutor, ctx: mockCtx });

      expect(result.finalText).toBe('Done.');
      expect(mockLLM.stream).toHaveBeenCalledTimes(4);
      // 验证 read 工具确实被执行了（是执行成功触发了计数器重置，而非仅仅没有抛错）
      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    });
  });

  // Step B: unknown stop_reason propagation (phase 788 / P0.15)
  it('propagates unknown stop_reason instead of collapsing to end_turn (phase 788 / P0.15)', async () => {
    // Mock LLM returning unrecognized stop_reason (e.g., refusal/safety/content_filter)
    (mockLLM.stream as ReturnType<typeof vi.fn>).mockImplementationOnce(async function* () {
      yield { type: 'text_delta', delta: 'partial refused response' };
      yield { type: 'done', stopReason: 'content_filter' };
    });

    const messages: Message[] = [{ role: 'user', content: 'Trigger refusal' }];

    const result = await runReact({
      messages,
      systemPrompt: '',
      llm: mockLLM,
      executor: mockExecutor,
      ctx: mockCtx,
      maxSteps: 5,
    });

    // Verify: stopReason propagates as 'unknown' (not collapsed to 'end_turn')
    expect(result.stopReason).toBe('unknown');
    // finalText still has partial content
    expect(result.finalText).toContain('partial refused response');
  });

});
