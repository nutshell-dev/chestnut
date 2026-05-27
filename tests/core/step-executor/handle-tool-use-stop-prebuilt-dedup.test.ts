import { describe, it, expect, vi } from 'vitest';
import { handleToolUseStop } from '../../../src/core/step-executor/stop-handlers.js';
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
      get: vi.fn().mockReturnValue({ readonly: true, supportsAsync: false }),
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
