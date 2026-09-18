/**
 * Phase 1227 Step A/B: StepExecutor write-ordering authority.
 *
 * All ordering proofs use executor-issued reached barriers; no wall-clock sleep.
 */

import { describe, it, expect, vi } from 'vitest';
import { executeToolCalls, executeSingleTool } from '../../../src/core/step-executor/tool-execution.js';
import { StepAbortError } from '../../../src/core/step-executor/index.js';
import { ToolError, ToolTimeoutError } from '../../../src/foundation/tools/index.js';
import type { ToolUseBlock } from '../../../src/foundation/llm-provider/types.js';
import type { ToolResult } from '../../../src/foundation/tool-protocol/types.js';
import type { ExecContext, IToolExecutor, ToolRegistry } from '../../../src/foundation/tools/index.js';

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: `toolu_${id}`, name, input };
}

function makeRegistry(readonlyNames: Set<string>): ToolRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    has: vi.fn(),
    getAll: vi.fn(),
    getForProfile: vi.fn(),
    formatForLLM: vi.fn(),
    get: (name: string) => {
      const readonly = readonlyNames.has(name);
      return {
        name,
        description: name,
        schema: { type: 'object', properties: {} },
        readonly,
        idempotent: readonly,
        profiles: ['subagent' as const],
        execute: vi.fn(),
      };
    },
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('executeToolCalls ordering', () => {
  const ctx = { signal: undefined } as unknown as ExecContext;

  it('write tools execute sequentially in tool-call order without overlap', async () => {
    const events: string[] = [];
    const writeAReached = createDeferred<void>();
    const releaseWriteA = createDeferred<void>();

    const executor: IToolExecutor = {
      execute: vi.fn(async ({ toolName }: { toolName: string }) => {
        events.push(`enter:${toolName}`);
        if (toolName === 'write_a') {
          writeAReached.resolve();
          await releaseWriteA.promise;
        }
        events.push(`exit:${toolName}`);
        return { success: true, content: toolName } as ToolResult;
      }),
      executeParallel: vi.fn(),
      validateArgs: vi.fn(() => ({ valid: true })),
      getToolSchema: vi.fn(),
    };

    const toolCalls: ToolUseBlock[] = [
      makeToolUseBlock('1', 'write_a'),
      makeToolUseBlock('2', 'write_b'),
    ];

    const execution = executeToolCalls(
      toolCalls,
      executor,
      ctx,
      makeRegistry(new Set()),
    );

    await writeAReached.promise;
    // write_a has entered execute() and is awaiting the release gate;
    // write_b must not have started yet because writes are sequential.
    expect(events).toEqual(['enter:write_a']);

    releaseWriteA.resolve();
    await execution;

    expect(events).toEqual([
      'enter:write_a',
      'exit:write_a',
      'enter:write_b',
      'exit:write_b',
    ]);
  });

  it('readonly tools are dispatched in a single parallel batch', async () => {
    const executor: IToolExecutor = {
      execute: vi.fn(),
      executeParallel: vi.fn(async () => [
        { success: true, content: 'read_a' } as ToolResult,
        { success: true, content: 'read_b' } as ToolResult,
      ]),
      validateArgs: vi.fn(() => ({ valid: true })),
      getToolSchema: vi.fn(),
    };

    const toolCalls: ToolUseBlock[] = [
      makeToolUseBlock('1', 'read_a'),
      makeToolUseBlock('2', 'read_b'),
    ];

    const results = await executeToolCalls(
      toolCalls,
      executor,
      ctx,
      makeRegistry(new Set(['read_a', 'read_b'])),
    );

    expect(executor.executeParallel).toHaveBeenCalledTimes(1);
    expect(executor.executeParallel).toHaveBeenCalledWith(
      [
        { toolName: 'read_a', args: {} },
        { toolName: 'read_b', args: {} },
      ],
      ctx,
    );
    expect(results.map(r => r.type)).toEqual(['tool_result', 'tool_result']);
  });

  it('mixed readonly + write runs readonly parallel first, then write sequentially', async () => {
    const events: string[] = [];
    const writeXReached = createDeferred<void>();
    const releaseWriteX = createDeferred<void>();

    const executor: IToolExecutor = {
      execute: vi.fn(async ({ toolName }: { toolName: string }) => {
        events.push(`write-enter:${toolName}`);
        if (toolName === 'write_x') {
          writeXReached.resolve();
          await releaseWriteX.promise;
        }
        events.push(`write-exit:${toolName}`);
        return { success: true, content: toolName } as ToolResult;
      }),
      executeParallel: vi.fn(async () => {
        events.push('readonly-batch');
        return [
          { success: true, content: 'read_y' } as ToolResult,
          { success: true, content: 'read_z' } as ToolResult,
        ];
      }),
      validateArgs: vi.fn(() => ({ valid: true })),
      getToolSchema: vi.fn(),
    };

    const toolCalls: ToolUseBlock[] = [
      makeToolUseBlock('1', 'write_x'),
      makeToolUseBlock('2', 'read_y'),
      makeToolUseBlock('3', 'read_z'),
      makeToolUseBlock('4', 'write_w'),
    ];

    const execution = executeToolCalls(
      toolCalls,
      executor,
      ctx,
      makeRegistry(new Set(['read_y', 'read_z'])),
    );

    await writeXReached.promise;
    // readonly batch must have completed before the first write entered.
    expect(events).toEqual(['readonly-batch', 'write-enter:write_x']);

    releaseWriteX.resolve();
    await execution;

    expect(events).toEqual([
      'readonly-batch',
      'write-enter:write_x',
      'write-exit:write_x',
      'write-enter:write_w',
      'write-exit:write_w',
    ]);
  });
});


describe('phase 1857 Step G (SE-D7): abort-mid-batch execution evidence', () => {
  function makeAbortCtx(signal: AbortSignal): ExecContext {
    return { signal } as unknown as ExecContext;
  }

  function makeAbortExecutor(onAfterFirst: () => void): IToolExecutor {
    return {
      execute: vi.fn(async ({ toolName }: { toolName: string }) => {
        const result = { success: true, content: `${toolName}-done` } as ToolResult;
        if (toolName === 'write_a') {
          onAfterFirst();
        }
        return result;
      }),
      executeParallel: vi.fn(),
      validateArgs: vi.fn(() => ({ valid: true })),
      getToolSchema: vi.fn(),
    };
  }

  it('第 2 个写工具前 abort → StepAbortError 携带第 1 个工具 evidence（已执行未提交可证明）', async () => {
    const controller = new AbortController();
    const executor = makeAbortExecutor(() => controller.abort({ type: 'user' }));
    const toolCalls: ToolUseBlock[] = [
      makeToolUseBlock('1', 'write_a'),
      makeToolUseBlock('2', 'write_b'),
    ];

    const err = await executeToolCalls(toolCalls, executor, makeAbortCtx(controller.signal), makeRegistry(new Set()))
      .catch(e => e);

    expect(err).toBeInstanceOf(StepAbortError);
    expect(err.reason).toEqual({ kind: 'user_interrupt' });
    expect(err.evidence).toEqual({
      completed: [{ toolName: 'write_a', toolUseId: 'toolu_1', success: true }],
    });
    // 第 2 个工具未执行
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('失败结果也入 evidence（success=false 随载体交付）', async () => {
    const controller = new AbortController();
    const executor: IToolExecutor = {
      execute: vi.fn(async ({ toolName }: { toolName: string }) => {
        if (toolName === 'write_a') {
          controller.abort({ type: 'step_yield' });
          return { success: false, content: 'a-failed' } as ToolResult;
        }
        return { success: true, content: toolName } as ToolResult;
      }),
      executeParallel: vi.fn(),
      validateArgs: vi.fn(() => ({ valid: true })),
      getToolSchema: vi.fn(),
    };
    const toolCalls: ToolUseBlock[] = [
      makeToolUseBlock('1', 'write_a'),
      makeToolUseBlock('2', 'write_b'),
    ];

    const err = await executeToolCalls(toolCalls, executor, makeAbortCtx(controller.signal), makeRegistry(new Set()))
      .catch(e => e);

    expect(err).toBeInstanceOf(StepAbortError);
    expect(err.evidence.completed).toEqual([{ toolName: 'write_a', toolUseId: 'toolu_1', success: false }]);
  });

  it('首工具前 abort（未执行）→ evidence.completed 为空，与「已执行未提交」可区分', async () => {
    const controller = new AbortController();
    controller.abort({ type: 'user' });
    const executor = makeAbortExecutor(() => {});
    const toolCalls: ToolUseBlock[] = [makeToolUseBlock('1', 'write_a')];

    const err = await executeToolCalls(toolCalls, executor, makeAbortCtx(controller.signal), makeRegistry(new Set()))
      .catch(e => e);

    expect(err).toBeInstanceOf(StepAbortError);
    expect(err.evidence).toEqual({ completed: [] });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('无 abort 的正常批 → evidence 路径不参与、结果完整', async () => {
    const executor = makeAbortExecutor(() => {});
    const toolCalls: ToolUseBlock[] = [
      makeToolUseBlock('1', 'write_a'),
      makeToolUseBlock('2', 'write_b'),
    ];

    const results = await executeToolCalls(toolCalls, executor, makeAbortCtx(new AbortController().signal), makeRegistry(new Set()));

    expect(results).toHaveLength(2);
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });
});


describe('phase 1857 Step H (SE-D8): 只收敛可呈现执行失败（三类矩阵）', () => {
  function makeSingleToolExecutor(err: unknown): IToolExecutor {
    return {
      execute: vi.fn(async () => { throw err; }),
      executeParallel: vi.fn(),
      validateArgs: vi.fn(() => ({ valid: true })),
      getToolSchema: vi.fn(),
    } as unknown as IToolExecutor;
  }

  const ctx = { signal: undefined } as unknown as ExecContext;
  const toolCall = { type: 'tool_use', id: 'toolu_h1', name: 'hTool', input: {} } as ToolUseBlock;

  it('ToolError → ToolResult（[ToolError] 文案保持）+ onToolExecutionFailed + audit 行', async () => {
    const onToolExecutionFailed = vi.fn();
    const aw = { write: vi.fn(), message: (s: string) => s, preview: (s: string) => s };

    const result = await executeSingleTool(
      toolCall,
      makeSingleToolExecutor(new ToolError('presentable-boom')),
      ctx,
      { onToolExecutionFailed } as never,
      aw as never,
    );

    expect(result.success).toBe(false);
    expect(result.content).toBe('[ToolError] 工具执行失败: [TOOL_EXECUTION_FAILED] presentable-boom');
    expect(onToolExecutionFailed).toHaveBeenCalledWith('hTool', 'toolu_h1', 'ToolError', '[TOOL_EXECUTION_FAILED] presentable-boom');
    expect(aw.write).toHaveBeenCalledWith(
      'tool_execution_failed', 'hTool', 'toolu_h1', 'errorType=ToolError', 'errorMsg=[TOOL_EXECUTION_FAILED] presentable-boom',
    );
  });

  it('ToolTimeoutError（ToolError 子类）→ ToolResult（[ToolTimeoutError] 文案保持）', async () => {
    const result = await executeSingleTool(
      toolCall,
      makeSingleToolExecutor(new ToolTimeoutError('hTool', 5000)),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('[ToolTimeoutError]');
    expect(result.content).toContain('[TOOL_TIMEOUT]');
  });

  it('控制信号（StepAbortError）→ rethrow，不被业务化为 ToolResult', async () => {
    const abortErr = new StepAbortError({ kind: 'user_interrupt' });

    await expect(
      executeSingleTool(toolCall, makeSingleToolExecutor(abortErr), ctx),
    ).rejects.toBe(abortErr);
  });

  it('系统故障（TypeError / invariant plain Error）→ rethrow，原语义保持', async () => {
    const typeErr = new TypeError('system-boom');
    await expect(
      executeSingleTool(toolCall, makeSingleToolExecutor(typeErr), ctx),
    ).rejects.toBe(typeErr);

    const invErr = new Error('[INVARIANT VIOLATION] tools/executor: something');
    await expect(
      executeSingleTool(toolCall, makeSingleToolExecutor(invErr), ctx),
    ).rejects.toBe(invErr);
  });
});
