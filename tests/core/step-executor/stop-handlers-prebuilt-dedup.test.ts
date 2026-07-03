/**
 * step-executor stop-handlers prebuilt dedup (phase 1282)
 *
 * phase 1395: merged from
 *   - handle-max-tokens-state-a-dedup.test.ts (handleMaxTokensStop)
 *   - handle-tool-use-stop-prebuilt-dedup.test.ts (handleToolUseStop)
 *
 * 两文件 share 完全相同 helper + 测同模块 stop-handlers 的不同 export，
 * collect-dominated (468ms collect / 24ms tests, ratio 20×)。
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMaxTokensStop, handleToolUseStop } from '../../../src/core/step-executor/stop-handlers.js';
import type { StepInput, LLMCallInfo, StepCallbacks } from '../../../src/core/step-executor/types.js';
import type { LLMResponse } from '../../../src/foundation/llm-provider/types.js';
import type { IToolExecutor } from '../../../src/foundation/tools/index.js';

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

describe('handleToolUseStop prebuilt dedup (phase 1282)', () => {
  it('反向: prebuilt 与 toolCall id 冲突时 skip execute、prebuilt 透传', async () => {
    const input = makeInput();
    input.messages = [];
    const execute = vi.fn().mockResolvedValue({ success: true, content: 'executed' });
    const executeParallel = vi.fn().mockResolvedValue([{ success: true, content: 'parallel' }]);
    const executor: IToolExecutor = {
      execute,
      executeParallel,
      validateArgs: vi.fn().mockReturnValue({ valid: true }),
    };
    input.executor = executor;
    const registry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn().mockReturnValue({ readonly: true }),
      has: vi.fn().mockReturnValue(true),
      getAll: vi.fn().mockReturnValue([]),
      getForProfile: vi.fn().mockReturnValue([]),
      formatForLLM: vi.fn().mockReturnValue([]),
    };
    input.registry = registry;
    const onMessageAppended = vi.fn();
    const callbacks: StepCallbacks = {
      onUnparseableToolUse: () => {},
      onMessageAppended,
    };
    input.callbacks = callbacks;

    const response: LLMResponse = {
      content: [
        { type: 'tool_use' as const, id: 'A', name: 'write', input: {} },
        { type: 'tool_result' as const, tool_use_id: 'A', content: 'parse error for A', is_error: true },
        { type: 'tool_use' as const, id: 'B', name: 'read', input: { x: 1 } },
      ],
      stop_reason: 'tool_use',
    };

    const result = await handleToolUseStop(response, input, makeLLMInfo());

    // executeParallel 只被调 1 次（仅 id=B / id=A 因 prebuilt cover 不 execute）
    expect(executeParallel).toHaveBeenCalledTimes(1);
    expect(executeParallel).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ toolName: 'read', args: { x: 1 } })]),
      expect.anything(),
    );

    // messages 末尾 user 含 2 tool_result：A (prebuilt 透传) + B (executor 结果)
    expect(input.messages).toHaveLength(2); // assistant + user
    const userMsg = input.messages[1];
    expect(userMsg.role).toBe('user');
    const results = userMsg.content as any[];
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'A', content: 'parse error for A' }));
    expect(results[1]).toEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'B' }));

    // 返回 continue + toolCallCount = 2（1 execute + 1 prebuilt）
    expect(result.kind).toBe('continue');
    expect((result as any).meta.toolCallCount).toBe(2);
    expect((result as any).meta.parseErrorCount).toBe(1);
  });
});
