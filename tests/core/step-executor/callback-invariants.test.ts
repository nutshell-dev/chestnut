/**
 * callback invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - callback-safe-wrap.test.ts
 *  - safe-callback-audit.test.ts
 *  - spawn-async-respected.test.ts
 *  - tool-input-parse-error-audit.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSingleTool } from '../../../src/core/step-executor/tool-execution.js';
import type { ExecContext, ToolResult } from '../../../src/foundation/tool-protocol/index.js';
import { executeStep } from '../../../src/core/step-executor/step-executor.js';
import type { LLMOrchestrator, LLMStreamChunk } from '../../../src/foundation/llm-orchestrator/index.js';
import type { LLMResponse } from '../../../src/foundation/llm-provider/types.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { IToolExecutor, ToolRegistry } from '../../../src/foundation/tools/executor.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { parseToolInput } from '../../../src/core/step-executor/utils.js';
import { ToolError } from '../../../src/foundation/tools/index.js';
import { makeStepEventSink } from '../../helpers/step-event-sink.js';

describe('callback-safe-wrap', () => {
  /**
   * Phase 890: callback safeCallback wrap reverse tests
   *
   * Reverse coverage: onToolInputParseError + onToolExecutionFailed throw
   * → onSafeCallbackError emit + structured return preserved.
   */

  describe('phase 890: callback safeCallback wrap', () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.restoreAllMocks();
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      consoleWarnSpy.mockRestore();
    });

    describe('onToolExecutionFailed throw isolation', () => {
      it('callback throw（执行已 fail 的 catch block 内）→ structured return 仍执行 + onSafeCallbackError 触发', async () => {
        const safeCallbackErrors: Array<{ label: string; err: unknown }> = [];
        const callbacks = {
          onToolExecutionFailed: vi.fn(() => { throw new Error('callback-boom'); }),
          onSafeCallbackError: (label: string, err: unknown) => {
            safeCallbackErrors.push({ label, err });
          },
        };

        const toolCall = {
          id: 'tu2',
          name: 'failTool',
          input: {},
        };

        // phase 1857 Step H (SE-D8): 可呈现执行失败须以公开 ToolError 声明——plain Error 现 rethrow
        const executor = {
          execute: vi.fn(async () => { throw new ToolError('exec-boom'); }),
        } as unknown as IToolExecutor;

        const ctx = {
          clawId: 'test',
          clawDir: '/tmp',
          workspaceDir: '/tmp',
          syncDir: '/tmp',
          callerType: 'main' as const,
          fs: {},
          profile: 'full' as const,
          stepNumber: 1,
          maxSteps: 10,
        } as ExecContext;

        // phase 1857 Step I: 裁决事件经单一事件出口（adapter 组合展示+持久化）
        const result = await executeSingleTool(
          toolCall as any, executor, ctx, callbacks as any,
          makeStepEventSink({ callbacks: callbacks as any }),
        );

        // 验证 1：structured return 不被 bypass、原 error 信息保留
        expect(result.success).toBe(false);
        expect(result.content).toContain('工具执行失败');
        expect(result.content).toContain('exec-boom');

        // 验证 2：callback 被 call 一次（throw 之前）
        expect(callbacks.onToolExecutionFailed).toHaveBeenCalledTimes(1);
        expect(callbacks.onToolExecutionFailed).toHaveBeenCalledWith('failTool', 'tu2', 'ToolError', '[TOOL_EXECUTION_FAILED] exec-boom');

        // 验证 3：onSafeCallbackError 被触发、label 对
        expect(safeCallbackErrors).toHaveLength(1);
        expect(safeCallbackErrors[0].label).toBe('onToolExecutionFailed');
        expect((safeCallbackErrors[0].err as Error).message).toBe('callback-boom');

        // 验证 4：console.warn 已移除（phase 1179: caller lifecycle audit 覆盖）
      });
    });
  });
});

describe('safe-callback-audit', () => {
  /**
   * StepExecutor safeCallback audit observability tests
   *
   * Reverse coverage: callback throw → onSafeCallbackError emit + console.warn dual-write.
   * (F2.7 / phase 845 Step B)
   */

  // ── Mock factories ──────────────────────────────────────────────────────────

  function makeMockLLM(responses: LLMResponse[]): LLMOrchestrator {
    let i = 0;
    async function* streamOne(r: LLMResponse): AsyncIterableIterator<LLMStreamChunk> {
      for (const block of r.content) {
        if (block.type === 'text') {
          yield { type: 'text_delta', delta: (block as { text: string }).text };
        } else if (block.type === 'tool_use') {
          const b = block as { id: string; name: string; input: unknown };
          yield { type: 'tool_use_start', toolUse: { id: b.id, name: b.name, partialInput: '' } };
          yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: JSON.stringify(b.input) } };
        }
      }
      yield {
        type: 'done',
        stopReason: r.stop_reason,
        usage: r.usage ? { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens } : undefined,
      };
    }
    return {
      call: vi.fn(),
      stream: vi.fn(() => streamOne(responses[i++] ?? responses[responses.length - 1])),
      healthCheck: vi.fn(async () => true),
      getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
      close: vi.fn(),
    } as unknown as LLMOrchestrator;
  }

  function makeExecutor(results: Record<string, ToolResult>): IToolExecutor {
    return {
      execute: vi.fn(async ({ toolName }) => results[toolName] ?? { success: true, content: 'default' }),
      executeParallel: vi.fn(),
      validateArgs: vi.fn(),
    } as unknown as IToolExecutor;
  }

  function makeRegistry(): ToolRegistry {
    return {
      get: () => ({ readonly: false }),
    } as unknown as ToolRegistry;
  }

  function makeCtx(): ExecContext {
    return makeExecContext();
  }

  // ── Tests ───────────────────────────────────────────────────────────────────

  describe('safeCallback audit observability (F2.7)', () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.restoreAllMocks();
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      consoleWarnSpy.mockRestore();
    });

    it('emits onSafeCallbackError when onToolResult throws, keeps console.warn, and does not break execution', async () => {
      const onSafeCallbackError = vi.fn();
      const onToolResult = vi.fn(() => { throw new Error('callback-boom'); });

      const llm = makeMockLLM([{
        content: [{ type: 'tool_use', id: 'tu1', name: 'testTool', input: {} }],
        stop_reason: 'tool_use',
      }]);

      const executor = makeExecutor({ testTool: { success: true, content: 'ok' } });
      const ctx = makeCtx();

      const result = await executeStep({
        messages: [] as Message[],
        systemPrompt: 'sys',
        llm,
        tools: [],
        executor,
        registry: makeRegistry(),
        ctx,
        callbacks: {
          onToolResult,
          onSafeCallbackError,
        },
      });

      // Execution must continue despite callback throw
      expect(result.kind).toBe('continue');

      // onToolResult itself was called (and threw)
      expect(onToolResult).toHaveBeenCalledWith('testTool', 'tu1', { success: true, content: 'ok' });

      // onSafeCallbackError audit callback fired
      expect(onSafeCallbackError).toHaveBeenCalledOnce();
      expect(onSafeCallbackError).toHaveBeenCalledWith('onToolResult', expect.any(Error));
      expect((onSafeCallbackError.mock.calls[0]![1] as Error).message).toBe('callback-boom');
    });

    it('emits onSafeCallbackError when onBeforeLLMCall throws', async () => {
      const onSafeCallbackError = vi.fn();
      const onBeforeLLMCall = vi.fn(() => { throw new Error('before-boom'); });

      const llm = makeMockLLM([{
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
      }]);

      const executor = makeExecutor({});
      const ctx = makeCtx();

      const result = await executeStep({
        messages: [] as Message[],
        systemPrompt: 'sys',
        llm,
        tools: [],
        executor,
        ctx,
        callbacks: {
          onBeforeLLMCall,
          onSafeCallbackError,
        },
      });

      expect(result.kind).toBe('final');
      expect(onBeforeLLMCall).toHaveBeenCalled();
      expect(onSafeCallbackError).toHaveBeenCalledOnce();
      expect(onSafeCallbackError).toHaveBeenCalledWith('onBeforeLLMCall', expect.any(Error));
    });
  });
});

describe('spawn-async-respected', () => {
  describe('phase 1050: spawn async parameter respected', () => {
    it('async=false → spawn receives args.async=false, no executor async dispatch', async () => {
      const executeCalls: Array<{ args: Record<string, unknown>; async?: boolean }> = [];
      const executor = {
        execute: vi.fn(async (opts) => {
          executeCalls.push({ args: opts.args, async: opts.async });
          return { success: true, content: 'ok' };
        }),
      };

      const toolCall = {
        id: 'tu1',
        name: 'spawn',
        input: { intent: 'test', async: false },
      };

      const ctx = {
        clawId: 'test',
        clawDir: '/tmp',
        profile: 'full',
        fs: {},
      } as any;

      const result = await executeSingleTool(toolCall as any, executor as any, ctx);

      expect(result.success).toBe(true);
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(executeCalls[0].args.async).toBe(false);
      expect(executeCalls[0].async).toBeUndefined();
    });

    it('async=true → spawn receives args.async=true, no executor async dispatch', async () => {
      const executeCalls: Array<{ args: Record<string, unknown>; async?: boolean }> = [];
      const executor = {
        execute: vi.fn(async (opts) => {
          executeCalls.push({ args: opts.args, async: opts.async });
          return { success: true, content: 'ok' };
        }),
      };

      const toolCall = {
        id: 'tu2',
        name: 'spawn',
        input: { intent: 'test', async: true },
      };

      const ctx = {
        clawId: 'test',
        clawDir: '/tmp',
        profile: 'full',
        fs: {},
      } as any;

      const result = await executeSingleTool(toolCall as any, executor as any, ctx);

      expect(result.success).toBe(true);
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(executeCalls[0].args.async).toBe(true);
      expect(executeCalls[0].async).toBeUndefined();
    });

    it('no async → spawn receives args.async undefined, default behavior preserved', async () => {
      const executeCalls: Array<{ args: Record<string, unknown>; async?: boolean }> = [];
      const executor = {
        execute: vi.fn(async (opts) => {
          executeCalls.push({ args: opts.args, async: opts.async });
          return { success: true, content: 'ok' };
        }),
      };

      const toolCall = {
        id: 'tu3',
        name: 'spawn',
        input: { intent: 'test' },
      };

      const ctx = {
        clawId: 'test',
        clawDir: '/tmp',
        profile: 'full',
        fs: {},
      } as any;

      const result = await executeSingleTool(toolCall as any, executor as any, ctx);

      expect(result.success).toBe(true);
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(executeCalls[0].args.async).toBeUndefined();
      expect(executeCalls[0].async).toBeUndefined();
    });
  });
});

describe('tool-input-parse-error-audit', () => {
  describe('step-executor — parseToolInput typed result (phase1079)', () => {
    it('returns ok=true with parsed data for valid JSON', () => {
      const result = parseToolInput('{"a":1}', 'tool');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({ a: 1 });
      }
    });

    it('returns ok=false with raw and error for invalid JSON', () => {
      const result = parseToolInput('{bad json', 'tool');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.raw).toBe('{bad json');
        expect(typeof result.error).toBe('string');
        expect(result.error.length).toBeGreaterThan(0);
      }
    });
  });
});


describe('phase 1857 Step F (SE-D6): 失败策略声明矩阵', () => {
  // 矩阵：每组代表 callback 故障 → 声明行为（B 级不中止 + 留证；S 级传播）

  function makeTextLLM(stopReason = 'end_turn'): LLMOrchestrator {
    async function* stream(): AsyncIterableIterator<LLMStreamChunk> {
      yield { type: 'text_delta', delta: 'hello' };
      yield { type: 'done', stopReason, usage: { inputTokens: 1, outputTokens: 1 } };
    }
    return {
      call: vi.fn(),
      stream: vi.fn(() => stream()),
      healthCheck: vi.fn(async () => true),
      getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
      close: vi.fn(),
    } as unknown as LLMOrchestrator;
  }

  function makeSink() {
    const entries: Array<unknown[]> = [];
    const sink = {
      write: (...cols: unknown[]) => { entries.push(cols); },
      message: (s: string) => s,
      preview: (s: string) => s,
    };
    return { sink, entries };
  }

  async function runStep(callbacks: Record<string, unknown>, stopReason = 'end_turn', auditWriter?: unknown) {
    return executeStep({
      messages: [] as Message[],
      systemPrompt: 'sys',
      llm: makeTextLLM(stopReason),
      tools: [],
      executor: {
        execute: vi.fn(async () => ({ success: true, content: 'ok' })),
        executeParallel: vi.fn(),
        validateArgs: vi.fn(),
      } as unknown as IToolExecutor,
      registry: { get: () => ({ readonly: false }) } as unknown as ToolRegistry,
      ctx: makeExecContext(),
      // phase 1857 Step I: 单一事件出口——展示+持久化经 caller adapter
      eventSink: makeStepEventSink({ callbacks: callbacks as never, audit: auditWriter }),
      callbacks: callbacks as never,
    });
  }

  it('[B:safe][提交通知] onMessageAppended throw → step 完成 final + onSafeCallbackError 留证 + audit 行', async () => {
    const onSafeCallbackError = vi.fn();
    const { sink: audit, entries } = makeSink();

    const result = await runStep({
      onMessageAppended: vi.fn(() => { throw new Error('append-boom'); }),
      onSafeCallbackError,
    }, 'end_turn', audit);

    expect(result.kind).toBe('final');
    expect(onSafeCallbackError).toHaveBeenCalledWith('onMessageAppended', expect.any(Error));
    expect(entries.some(c => c[0] === 'step_executor_callback_failed' && String(c[1]).includes('onMessageAppended'))).toBe(true);
    expect(audit).toBeDefined();
  });

  it('[B:safe][stream delivery] onTextDelta throw → step 完成 final（stream loop 不中断）', async () => {
    const onSafeCallbackError = vi.fn();

    const result = await runStep({
      onTextDelta: vi.fn(() => { throw new Error('delta-boom'); }),
      onSafeCallbackError,
    });

    expect(result.kind).toBe('final');
    expect(onSafeCallbackError).toHaveBeenCalledWith('onTextDelta', expect.any(Error));
  });

  it('[B:safe][裁决事件] onUnknownStopReason throw → step 完成 final(unknown)（通知失败不改变已发生提交）', async () => {
    const onSafeCallbackError = vi.fn();

    const result = await runStep({
      onUnknownStopReason: vi.fn(() => { throw new Error('unknown-boom'); }),
      onSafeCallbackError,
    }, 'refusal');

    expect(result.kind).toBe('final');
    if (result.kind === 'final') expect(result.stopReason).toBe('unknown');
    expect(onSafeCallbackError).toHaveBeenCalledWith('onUnknownStopReason', expect.any(Error));
  });

  it('[S:strict][提交通知] onLLMResult throw → executeStep 拒绝、错误原样传播（可中止 step）', async () => {
    const onLLMResult = vi.fn(() => { throw new Error('result-boom'); });

    await expect(runStep({ onLLMResult })).rejects.toThrow('result-boom');
    expect(onLLMResult).toHaveBeenCalledOnce();
  });

  it('[B:safe] onBeforeLLMCall throw → step 完成 final（phase 890 契约保持，不中断）', async () => {
    const onSafeCallbackError = vi.fn();

    const result = await runStep({
      onBeforeLLMCall: vi.fn(() => { throw new Error('before-boom'); }),
      onSafeCallbackError,
    });

    expect(result.kind).toBe('final');
    expect(onSafeCallbackError).toHaveBeenCalledWith('onBeforeLLMCall', expect.any(Error));
  });
});
