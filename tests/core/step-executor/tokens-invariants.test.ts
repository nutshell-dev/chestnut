/**
 * tokens invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - max-tokens-prebuilt-only-final.test.ts
 *  - max-tokens-no-empty-assistant.test.ts
 *  - max-tokens-state-a-orphan-drop.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMaxTokensStop } from '../../../src/core/step-executor/stop-handlers.js';
import type { StepInput, LLMCallInfo } from '../../../src/core/step-executor/types.js';
import type { LLMResponse } from '../../../src/foundation/llm-provider/types.js';

describe('max-tokens-prebuilt-only-final', () => {
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
});

describe('max-tokens-no-empty-assistant', () => {
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
});

describe('max-tokens-state-a-orphan-drop', () => {
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
});
