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

describe('phase 1383: handleMaxTokensStop State A orphan prebuilt observability', () => {
  it('orphan prebuilt 触发 onMaxTokensStateAOrphanDrop callback (非 parseError + id 不在 toolCalls)', () => {
    const onMaxTokensStateAOrphanDrop = vi.fn();
    const input = makeInput();
    input.messages = [];
    input.callbacks = {
      onUnparseableToolUse: () => {},
      onMaxTokensStateAOrphanDrop,
    };

    const response: LLMResponse = {
      content: [
        { type: 'tool_use' as const, id: 'tc_new', name: 'exec', input: {} },
        { type: 'tool_result' as const, tool_use_id: 'tc_orphan', content: 'real prior result', is_error: false },
      ],
      stop_reason: 'max_tokens',
    };

    handleMaxTokensStop(response, input, makeLLMInfo(), 4096);

    expect(onMaxTokensStateAOrphanDrop).toHaveBeenCalledOnce();
    expect(onMaxTokensStateAOrphanDrop).toHaveBeenCalledWith(expect.objectContaining({
      orphans: [expect.objectContaining({
        tool_use_id: 'tc_orphan',
        content: 'real prior result',
        is_error: false,
      })],
      llm: expect.objectContaining({ model: 'test-model' }),
    }));

    // orphan 仍 drop from messages (phase 1282 ratify 不破)
    const lastUserMsg = input.messages[input.messages.length - 1];
    const orphanInMsg = JSON.stringify(lastUserMsg).includes('tc_orphan');
    expect(orphanInMsg).toBe(false);
  });

  it('parseError prebuilt 不触发 orphan callback (phase 1282 透传路径不破)', () => {
    const onMaxTokensStateAOrphanDrop = vi.fn();
    const input = makeInput();
    input.messages = [];
    input.callbacks = {
      onUnparseableToolUse: () => {},
      onMaxTokensStateAOrphanDrop,
    };

    const response: LLMResponse = {
      content: [
        { type: 'tool_use' as const, id: 'tc_parse', name: 'exec', input: {} },
        { type: 'tool_result' as const, tool_use_id: 'tc_parse', content: 'Tool input JSON parse failed for "exec". Raw: {"content":"partial', is_error: true },
      ],
      stop_reason: 'max_tokens',
    };

    handleMaxTokensStop(response, input, makeLLMInfo(), 4096);

    expect(onMaxTokensStateAOrphanDrop).not.toHaveBeenCalled();
  });

  it('paired prebuilt (id in toolCalls) 不触发 orphan callback (phase 1282 dedup 路径不破)', () => {
    const onMaxTokensStateAOrphanDrop = vi.fn();
    const input = makeInput();
    input.messages = [];
    input.callbacks = {
      onUnparseableToolUse: () => {},
      onMaxTokensStateAOrphanDrop,
    };

    const response: LLMResponse = {
      content: [
        { type: 'tool_use' as const, id: 'tc_x', name: 'exec', input: {} },
        { type: 'tool_result' as const, tool_use_id: 'tc_x', content: 'real result for tc_x', is_error: false },
      ],
      stop_reason: 'max_tokens',
    };

    handleMaxTokensStop(response, input, makeLLMInfo(), 4096);

    expect(onMaxTokensStateAOrphanDrop).not.toHaveBeenCalled();
  });
});
