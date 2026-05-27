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

describe('handleMaxTokensStop prebuilt-only final (phase 1274)', () => {
  it('反向: response.content 仅含 prebuilt tool_result → final + messages 不变 + callback 触发', () => {
    const input = makeInput();
    input.messages = [{ role: 'user', content: 'hello' }];
    const onMaxTokensPrebuiltOnlyFinal = vi.fn();
    input.callbacks = { onMaxTokensPrebuiltOnlyFinal, onUnparseableToolUse: () => {} };

    const response: LLMResponse = {
      content: [
        { type: 'tool_result' as const, tool_use_id: 'historical_1', content: 'stale' },
      ],
      stop_reason: 'max_tokens',
    };

    const result = handleMaxTokensStop(response, input, makeLLMInfo(), 4096);

    expect(result.kind).toBe('final');
    expect((result as { stopReason: string }).stopReason).toBe('max_tokens_text');
    expect(input.messages).toHaveLength(1);
    expect(onMaxTokensPrebuiltOnlyFinal).toHaveBeenCalledTimes(1);
    expect(onMaxTokensPrebuiltOnlyFinal).toHaveBeenCalledWith({
      prebuiltCount: 1,
      llm: makeLLMInfo(),
    });
  });

  it('反向: 多个 prebuilt tool_result → callback prebuiltCount 正确', () => {
    const input = makeInput();
    const onMaxTokensPrebuiltOnlyFinal = vi.fn();
    input.callbacks = { onMaxTokensPrebuiltOnlyFinal, onUnparseableToolUse: () => {} };

    const response: LLMResponse = {
      content: [
        { type: 'tool_result' as const, tool_use_id: 'a', content: 'stale' },
        { type: 'tool_result' as const, tool_use_id: 'b', content: 'stale' },
      ],
      stop_reason: 'max_tokens',
    };

    const result = handleMaxTokensStop(response, input, makeLLMInfo(), 4096);

    expect(result.kind).toBe('final');
    expect(onMaxTokensPrebuiltOnlyFinal).toHaveBeenCalledWith(expect.objectContaining({ prebuiltCount: 2 }));
  });
});
