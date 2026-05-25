import { describe, it, expect, vi } from 'vitest';
import { handleMaxTokensStop } from '../../../src/core/step-executor/stop-handlers.js';
import type { StepInput, LLMCallInfo } from '../../../src/core/step-executor/types.js';
import type { LLMResponse } from '../../../src/foundation/llm-provider/types.js';

function makeInput(): StepInput {
  return {
    messages: [],
    systemPrompt: '',
    llm: {} as any,
    tools: [],
    executor: {} as any,
    ctx: { signal: undefined } as any,
  };
}

function makeLLMInfo(): LLMCallInfo {
  return { model: 'test-model', inputTokens: 10, outputTokens: 10, latencyMs: 100 };
}

describe('handleMaxTokensStop no empty assistant (phase 1274)', () => {
  it('反向: tool_use + historical tool_result → append assistant with tool_use only + truncated for tool_use only', () => {
    const input = makeInput();
    input.messages = [
      { role: 'assistant', content: [{ type: 'tool_use' as const, id: 'hist', name: 'foo', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result' as const, tool_use_id: 'hist', content: 'ok' }] },
    ];
    const onMessageAppended = vi.fn();
    const onMaxTokensAssistantEmptySkipped = vi.fn();
    input.callbacks = {
      onMessageAppended,
      onMaxTokensAssistantEmptySkipped,
      onUnparseableToolUse: () => {},
    };

    const response: LLMResponse = {
      content: [
        { type: 'tool_use' as const, id: 'new_call', name: 'bar', input: {} },
        { type: 'tool_result' as const, tool_use_id: 'hist', content: 'stale_repeat' },
      ],
      stop_reason: 'max_tokens',
    };

    const result = handleMaxTokensStop(response, input, makeLLMInfo(), 4096);

    expect(result.kind).toBe('max_tokens_tool_use');
    // assistant message appended: only tool_use, not tool_result
    const lastAssistant = input.messages.filter(m => m.role === 'assistant').pop();
    expect(lastAssistant).toBeDefined();
    expect(Array.isArray(lastAssistant!.content)).toBe(true);
    expect((lastAssistant!.content as any[]).length).toBe(1);
    expect((lastAssistant!.content as any[])[0].type).toBe('tool_use');
    expect((lastAssistant!.content as any[])[0].id).toBe('new_call');
    // truncated result only for new_call
    const lastUser = input.messages.filter(m => m.role === 'user').pop();
    expect(Array.isArray(lastUser!.content)).toBe(true);
    expect((lastUser!.content as any[]).length).toBe(1);
    expect((lastUser!.content as any[])[0].tool_use_id).toBe('new_call');
    expect(onMaxTokensAssistantEmptySkipped).not.toHaveBeenCalled();
  });

  it('边界: response 只含 thinking 块 → filter 后 assistantBlocks 空 → skip + onMaxTokensAssistantEmptySkipped 触发', () => {
    const input = makeInput();
    const onMaxTokensAssistantEmptySkipped = vi.fn();
    const onMessageAppended = vi.fn();
    input.callbacks = {
      onMaxTokensAssistantEmptySkipped,
      onMessageAppended,
      onUnparseableToolUse: () => {},
    };

    const response: LLMResponse = {
      content: [
        { type: 'thinking' as const, thinking: '...' },
      ],
      stop_reason: 'max_tokens',
    };

    const result = handleMaxTokensStop(response, input, makeLLMInfo(), 4096);

    expect(result.kind).toBe('final');
    expect(onMaxTokensAssistantEmptySkipped).toHaveBeenCalledTimes(1);
    expect(onMessageAppended).not.toHaveBeenCalledWith('assistant', expect.anything());
  });
});
