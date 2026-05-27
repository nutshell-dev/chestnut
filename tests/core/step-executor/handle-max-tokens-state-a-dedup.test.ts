import { describe, it, expect, vi } from 'vitest';
import { handleMaxTokensStop } from '../../../src/core/step-executor/stop-handlers.js';
import type { StepInput, LLMCallInfo, StepCallbacks } from '../../../src/core/step-executor/types.js';
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

describe('handleMaxTokensStop State A dedup (phase 1282)', () => {
  it('反向: prebuilt id 已 cover 时 skip synthesize [TRUNCATED]，prebuilt 透传', () => {
    const input = makeInput();
    input.messages = [];
    const onMessageAppended = vi.fn();
    const callbacks: StepCallbacks = {
      onUnparseableToolUse: () => {},
      onMessageAppended,
    };
    input.callbacks = callbacks;

    const response: LLMResponse = {
      content: [
        { type: 'tool_use' as const, id: 'A', name: 'write', input: {} },
        { type: 'tool_result' as const, tool_use_id: 'A', content: 'Tool input JSON parse failed for "write". Raw: {"content":"partial', is_error: true },
      ],
      stop_reason: 'max_tokens',
    };

    const result = handleMaxTokensStop(response, input, makeLLMInfo(), 4096);

    // assistant 含 tool_use(id=A)
    expect(input.messages).toHaveLength(2);
    const assistantMsg = input.messages[0];
    expect(assistantMsg.role).toBe('assistant');
    expect((assistantMsg.content as any[]).some((b: any) => b.type === 'tool_use' && b.id === 'A')).toBe(true);

    // user 含 1 tool_result：prebuilt 透传（parseError），不含 [TRUNCATED]
    const userMsg = input.messages[1];
    expect(userMsg.role).toBe('user');
    const results = userMsg.content as any[];
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({
      type: 'tool_result',
      tool_use_id: 'A',
      content: expect.stringContaining('parse failed'),
      is_error: true,
    }));
    expect(results[0].content).not.toContain('TRUNCATED');

    expect(result.kind).toBe('max_tokens_tool_use');
    expect(onMessageAppended).toHaveBeenCalledWith('assistant', 1);
    expect(onMessageAppended).toHaveBeenCalledWith('user', 1);
  });

  it('正常 State A: 无 prebuilt 时 synthesize [TRUNCATED]', () => {
    const input = makeInput();
    input.messages = [];
    const onMessageAppended = vi.fn();
    const callbacks: StepCallbacks = {
      onUnparseableToolUse: () => {},
      onMessageAppended,
    };
    input.callbacks = callbacks;

    const response: LLMResponse = {
      content: [
        { type: 'tool_use' as const, id: 'A', name: 'read', input: { x: 1 } },
      ],
      stop_reason: 'max_tokens',
    };

    const result = handleMaxTokensStop(response, input, makeLLMInfo(), 4096);

    const userMsg = input.messages[1];
    expect(userMsg.role).toBe('user');
    const results = userMsg.content as any[];
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({
      type: 'tool_result',
      tool_use_id: 'A',
      content: expect.stringContaining('TRUNCATED'),
      is_error: true,
    }));

    expect(result.kind).toBe('max_tokens_tool_use');
  });
});
