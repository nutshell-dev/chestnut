/**
 * @module L3.StepExecutor.ToolExecution
 * Tool execution strategies — categorize + 4 parallel strategy + sequential / single
 *
 * 4 strategies (per tool readonly + async flag):
 * - executeSequential: 无 registry 时串行
 * - executeReadonlyAsync: 只读 + async=true 异步
 * - executeReadonlySync: 只读 + async=false 同步并行
 * - executeWriteCalls: 写工具串行
 */

import type { ToolUseBlock, ToolResultBlock } from '../../types/message.js';
import type { ExecContext, ToolResult } from '../../foundation/tool-protocol/index.js';
import type { IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { StepCallbacks } from './types.js';
import { safeCallback, toToolResultBlock } from './utils.js';
import { throwAbortError } from './abort-helpers.js';


interface CategorizedCalls {
  readonlyAsync: { call: ToolUseBlock; index: number }[];
  readonlySync: { call: ToolUseBlock; index: number }[];
  write: { call: ToolUseBlock; index: number }[];
}

function categorizeToolCalls(
  toolCalls: ToolUseBlock[],
  registry: ToolRegistry,
): CategorizedCalls {
  const readonlyAsync: { call: ToolUseBlock; index: number }[] = [];
  const readonlySync: { call: ToolUseBlock; index: number }[] = [];
  const write: { call: ToolUseBlock; index: number }[] = [];

  for (const [i, call] of toolCalls.entries()) {
    const tool = registry.get(call.name);
    const wantsAsync = (call.input as Record<string, unknown>)?.async === true;
    if (tool?.readonly === true && !wantsAsync) {
      readonlySync.push({ call, index: i });
    } else if (tool?.readonly === true && wantsAsync) {
      readonlyAsync.push({ call, index: i });
    } else {
      write.push({ call, index: i });
    }
  }
  return { readonlyAsync, readonlySync, write };
}

async function executeSequential(
  toolCalls: ToolUseBlock[],
  executor: IToolExecutor,
  ctx: ExecContext,
  callbacks?: StepCallbacks,
): Promise<ToolResultBlock[]> {
  // 注：onToolCall 已在 stream.ts:tool_use_start 时调（流式提前 emit / 不等 execute）
  const results: ToolResultBlock[] = [];
  for (const call of toolCalls) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    const result = await executeSingleTool(call, executor, ctx, callbacks);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result), callbacks);
    results.push(toToolResultBlock(call.id, result));
  }
  return results;
}

async function executeReadonlyAsync(
  group: { call: ToolUseBlock; index: number }[],
  executor: IToolExecutor,
  ctx: ExecContext,
  results: Map<number, ToolResultBlock>,
  callbacks?: StepCallbacks,
): Promise<void> {
  const parseErrorCalls = group.filter(
    ({ call }) => (call.input as Record<string, unknown>)?.__parseError === true
  );
  const cleanCalls = group.filter(
    ({ call }) => (call.input as Record<string, unknown>)?.__parseError !== true
  );

  // 注：onToolCall 已在 stream.ts:tool_use_start 时调
  for (const { call, index } of parseErrorCalls) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    const result = await executeSingleTool(call, executor, ctx, callbacks);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result), callbacks);
    results.set(index, toToolResultBlock(call.id, result));
  }

  if (cleanCalls.length === 0) return;

  const batch = cleanCalls.map(({ call }) => {
    const { async: _asyncMode, ...toolArgs } = call.input as Record<string, unknown>;
    return { toolName: call.name, args: toolArgs };
  });

  const parallelResults = await executor.executeParallel(batch, ctx);

  for (let i = 0; i < cleanCalls.length; i++) {
    const { call, index } = cleanCalls[i];
    const result = parallelResults[i];
    if (!result) {
      const singleResult = await executeSingleTool(call, executor, ctx, callbacks);
      safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, singleResult), callbacks);
      results.set(index, toToolResultBlock(call.id, singleResult));
      continue;
    }
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result), callbacks);
    results.set(index, toToolResultBlock(call.id, result));
  }
}

async function executeReadonlySync(
  group: { call: ToolUseBlock; index: number }[],
  executor: IToolExecutor,
  ctx: ExecContext,
  results: Map<number, ToolResultBlock>,
  callbacks?: StepCallbacks,
): Promise<void> {
  const parseErrorCalls = group.filter(
    ({ call }) => (call.input as Record<string, unknown>)?.__parseError === true
  );
  const cleanCalls = group.filter(
    ({ call }) => (call.input as Record<string, unknown>)?.__parseError !== true
  );

  // 注：onToolCall 已在 stream.ts:tool_use_start 时调
  for (const { call, index } of parseErrorCalls) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    const result = await executeSingleTool(call, executor, ctx, callbacks);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result), callbacks);
    results.set(index, toToolResultBlock(call.id, result));
  }

  if (cleanCalls.length === 0) return;

  const batch = cleanCalls.map(({ call }) => {
    const { async: _asyncMode, ...toolArgs } = call.input as Record<string, unknown>;
    return { toolName: call.name, args: toolArgs };
  });

  const parallelResults = await executor.executeParallel(batch, ctx);

  for (let i = 0; i < cleanCalls.length; i++) {
    const { call, index } = cleanCalls[i];
    const result = parallelResults[i];
    if (!result) {
      const singleResult = await executeSingleTool(call, executor, ctx, callbacks);
      safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, singleResult), callbacks);
      results.set(index, toToolResultBlock(call.id, singleResult));
      continue;
    }
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result), callbacks);
    results.set(index, toToolResultBlock(call.id, result));
  }
}

async function executeWriteCalls(
  group: { call: ToolUseBlock; index: number }[],
  executor: IToolExecutor,
  ctx: ExecContext,
  results: Map<number, ToolResultBlock>,
  callbacks?: StepCallbacks,
): Promise<void> {
  // 注：onToolCall 已在 stream.ts:tool_use_start 时调
  for (const { call, index } of group) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    const result = await executeSingleTool(call, executor, ctx, callbacks);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, call.id, result), callbacks);
    results.set(index, toToolResultBlock(call.id, result));
  }
}

export async function executeToolCalls(
  toolCalls: ToolUseBlock[],
  executor: IToolExecutor,
  ctx: ExecContext,
  registry: ToolRegistry | undefined,
  callbacks?: StepCallbacks,
): Promise<ToolResultBlock[]> {
  if (!registry) return executeSequential(toolCalls, executor, ctx, callbacks);

  const { readonlyAsync, readonlySync, write } = categorizeToolCalls(toolCalls, registry);
  const results = new Map<number, ToolResultBlock>();

  await executeReadonlyAsync(readonlyAsync, executor, ctx, results, callbacks);
  await executeReadonlySync(readonlySync, executor, ctx, results, callbacks);
  await executeWriteCalls(write, executor, ctx, results, callbacks);

  return toolCalls.map((_, i) => {
    const r = results.get(i);
    if (!r) throw new Error(`[step-executor] Missing result for tool call at index ${i}`);
    return r;
  });
}

export async function executeSingleTool(
  toolCall: ToolUseBlock,
  executor: IToolExecutor,
  ctx: ExecContext,
  callbacks?: StepCallbacks,
): Promise<ToolResult> {
  try {
    // async is NOT a universal meta-parameter — some tools (spawn) use it as
    // an internal parameter. Only readonly tools with supportsAsync use
    // executor-level async dispatch, and they go through executeReadonlyAsync.
    const { __parseError, __raw, ...toolArgs } = toolCall.input as Record<string, unknown>;

    // Input JSON failed to parse — return error immediately without calling the tool
    if (__parseError) {
      safeCallback(
        'onToolInputParseError',
        () => callbacks?.onToolInputParseError?.(toolCall.name, toolCall.id, String(__raw || '')),
        callbacks,
      );
      return {
        success: false,
        content: `工具输入 JSON 解析失败，无法调用工具 "${toolCall.name}"。原始输入: ${String(__raw || '')}`,
        metadata: { parseError: true },
      };
    }

    return await executor.execute({
      toolName: toolCall.name,
      args: toolArgs,  // async stays in args for tools that read it internally
      ctx,
      toolUseId: toolCall.id,
      timeoutMs: (toolCall.input as Record<string, unknown>)?.timeoutMs as number | undefined,
    });
  } catch (err) {
    const errorType = err instanceof Error ? err.constructor.name : 'Error';
    const errorMsg = err instanceof Error ? err.message : String(err);
    safeCallback(
      'onToolExecutionFailed',
      () => callbacks?.onToolExecutionFailed?.(toolCall.name, toolCall.id, errorType, errorMsg),
      callbacks,
    );
    console.error(`[step-executor] Tool ${toolCall.name} execution failed:`, errorMsg);
    return {
      success: false,
      content: `[${errorType}] 工具执行失败: ${errorMsg}`,
    };
  }
}
