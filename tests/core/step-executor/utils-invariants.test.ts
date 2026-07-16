/**
 * utils invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - utils-addedat.test.ts
 *  - step_executor_persist_ref.test.ts
 *  - stop-handlers-prebuilt-dedup.test.ts
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  appendAssistantMessage,
  appendToolResults,
  parseToolInput,
  safeCallback,
  toToolResultBlock,
} from '../../../src/core/step-executor/utils.js';
import type { Message, LLMResponse } from '../../../src/foundation/llm-provider/types.js';
import { executeStep } from '../../../src/core/step-executor/step-executor.js';
import { handleMaxTokensStop, handleToolUseStop } from '../../../src/core/step-executor/stop-handlers.js';
import type { StepInput, LLMCallInfo, StepCallbacks } from '../../../src/core/step-executor/types.js';
import type { IToolExecutor } from '../../../src/foundation/tools/index.js';

describe('utils-addedat', () => {
  describe('step-executor utils addedAt (phase 436)', () => {
    it('appendAssistantMessage fills addedAt', () => {
      const messages: Message[] = [];
      appendAssistantMessage(messages, [{ type: 'text', text: 'hi' }]);
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe('assistant');
      expect(typeof messages[0].addedAt).toBe('string');
      expect(messages[0].origin).toBeUndefined();
    });

    it('appendToolResults fills addedAt without origin', () => {
      const messages: Message[] = [];
      const result = toToolResultBlock('toolu_1', { success: true, content: 'ok' });
      appendToolResults(messages, [result]);
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe('user');
      expect(typeof messages[0].addedAt).toBe('string');
      expect(messages[0].origin).toBeUndefined();
    });
  });
});

describe('step_executor_persist_ref', () => {
  describe('step-executor messages persist ref (phase 224)', () => {
    it('budget 未超时、messages 引用不变 + push 落原引用', async () => {
      const messages: Message[] = [{ role: 'user', content: 'hi' }];
      const mockLLM = {
        stream: async function* () {
          yield { type: 'text_delta' as const, delta: 'hi' };
          yield { type: 'done' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } };
        },
        getProviderInfo: () => ({ model: 'volc-ds4pro', name: 'volc-ds4pro' }),
      };
      await executeStep({
        messages, systemPrompt: 's', llm: mockLLM as any, tools: [],
        executor: {} as any, registry: {} as any,
        ctx: { stepNumber: 0 as any } as any, callbacks: {}, maxTokens: 100,
      });
      expect(messages.length).toBe(2);
      expect(messages.at(-1)?.role).toBe('assistant');
    });

    it('budget 超时（trim 触发）、push 仍落 caller 原引用', async () => {
      // 构造多条 messages：中间一条超大 assistant 可被 trim、首尾 user 受保护
      // phase 255 → phase 286: shrink further (30000 → 22000) — still > 64k tokens which
      // exceeds the deepseek-chat budget, trim still triggers.
      const bigAssistant: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello world '.repeat(22000) }],
      };
      const messages: Message[] = [
        { role: 'user', content: 'hi' },
        bigAssistant,
        { role: 'user', content: 'bye' },
      ];
      const mockLLM = {
        stream: async function* () {
          yield { type: 'text_delta' as const, delta: 'short' };
          yield { type: 'done' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } };
        },
        getProviderInfo: () => ({ model: 'deepseek-chat', name: 'deepseek-chat' }),
      };
      await executeStep({
        messages, systemPrompt: 's', llm: mockLLM as any, tools: [],
        executor: {} as any, registry: {} as any,
        ctx: { stepNumber: 0 as any } as any, callbacks: {}, maxTokens: 100,
      });
      // 关键 invariant：caller 持有的 messages 数组应被 push、不被切断
      expect(messages.length).toBeGreaterThanOrEqual(4);
      expect(messages.at(-1)?.role).toBe('assistant');
    });
  });
});

describe('stop-handlers-prebuilt-dedup', () => {
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
});

describe('parseToolInput', () => {
  it('parses valid JSON object', () => {
    const result = parseToolInput('{"key":"value","n":42}', 'tool-name');
    expect(result).toEqual({ ok: true, data: { key: 'value', n: 42 } });
  });

  it('returns empty object for empty string', () => {
    const result = parseToolInput('', 'tool-name');
    expect(result).toEqual({ ok: true, data: {} });
  });

  it('returns typed error for invalid JSON', () => {
    const result = parseToolInput('{ invalid', 'tool-name');
    expect(result).toEqual({
      ok: false,
      raw: '{ invalid',
      error: expect.any(String),
    });
  });

  it('handles null-like raw via empty default', () => {
    const result = parseToolInput(null as unknown as string, 'tool-name');
    expect(result).toEqual({ ok: true, data: {} });
  });
});

describe('safeCallback', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('executes callback normally without warn', () => {
    const fn = vi.fn();
    safeCallback('onTurnStart', fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('catches throwing Error without warn and without breaking execution', () => {
    const fn = vi.fn(() => { throw new Error('boom'); });
    expect(() => safeCallback('onStep', fn)).not.toThrow();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('catches non-Error throw without warn and without breaking execution', () => {
    const fn = vi.fn(() => { throw 'string-err'; });
    expect(() => safeCallback('onAbort', fn)).not.toThrow();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('emits onSafeCallbackError when callback throws and callbacks provided', () => {
    const fn = vi.fn(() => { throw new Error('boom'); });
    const onSafeCallbackError = vi.fn();
    expect(() => safeCallback('onStep', fn, { onSafeCallbackError })).not.toThrow();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(onSafeCallbackError).toHaveBeenCalledOnce();
    expect(onSafeCallbackError).toHaveBeenCalledWith('onStep', expect.any(Error));
    expect((onSafeCallbackError.mock.calls[0]![1] as Error).message).toBe('boom');
  });

  it('does not emit onSafeCallbackError when callbacks omitted', () => {
    const fn = vi.fn(() => { throw new Error('boom'); });
    expect(() => safeCallback('onStep', fn)).not.toThrow();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('does not emit onSafeCallbackError when callback succeeds', () => {
    const fn = vi.fn();
    const onSafeCallbackError = vi.fn();
    safeCallback('onStep', fn, { onSafeCallbackError });
    expect(onSafeCallbackError).not.toHaveBeenCalled();
  });
});
