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

import type { ToolUseBlock, ToolResultBlock } from '../../foundation/llm-provider/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { StepInput, StepCallbacks } from './types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { safeCallback, toToolResultBlock } from './utils.js';
import { throwAbortError } from './abort-helpers.js';
import { STEP_EXECUTOR_AUDIT_EVENTS } from './audit-events.js';

import { makeToolUseId } from '../../foundation/tool-protocol/index.js';



function toSafeNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isNaN(n) || !Number.isFinite(n) ? undefined : n;
}

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
    const wantsAsync = call.input?.async === true;
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

function isStepInput(value: StepCallbacks | StepInput): value is StepInput {
  return 'messages' in value;
}

function resolveCallbacksAndAudit(
  callbacksOrInput?: StepCallbacks | StepInput,
  auditWriter?: AuditLog,
): { callbacks?: StepCallbacks; auditWriter?: AuditLog } {
  if (callbacksOrInput && isStepInput(callbacksOrInput)) {
    return { callbacks: callbacksOrInput.callbacks, auditWriter: callbacksOrInput.auditWriter ?? auditWriter };
  }
  return { callbacks: callbacksOrInput, auditWriter };
}

async function executeSequential(
  toolCalls: ToolUseBlock[],
  executor: IToolExecutor,
  ctx: ExecContext,
  callbacksOrInput?: StepCallbacks | StepInput,
  auditWriter?: AuditLog,
): Promise<ToolResultBlock[]> {
  const { callbacks, auditWriter: aw } = resolveCallbacksAndAudit(callbacksOrInput, auditWriter);
  // 注：onToolCall 已在 stream.ts:tool_use_start 时调（流式提前 emit / 不等 execute）
  const results: ToolResultBlock[] = [];
  for (const call of toolCalls) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    const result = await executeSingleTool(call, executor, ctx, callbacksOrInput, auditWriter);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, makeToolUseId(call.id), result), callbacks, aw);
    results.push(toToolResultBlock(makeToolUseId(call.id), result));
  }
  return results;
}

async function executeReadonlyAsync(
  group: { call: ToolUseBlock; index: number }[],
  executor: IToolExecutor,
  ctx: ExecContext,
  results: Map<number, ToolResultBlock>,
  callbacksOrInput?: StepCallbacks | StepInput,
  auditWriter?: AuditLog,
): Promise<void> {
  if (group.length === 0) return;

  const { callbacks, auditWriter: aw } = resolveCallbacksAndAudit(callbacksOrInput, auditWriter);

  const batch = group.map(({ call }) => {
    const { async: _asyncMode, ...toolArgs } = call.input;
    return { toolName: call.name, args: toolArgs };
  });

  const parallelResults = await executor.executeParallel(batch, ctx);

  for (let i = 0; i < group.length; i++) {
    const { call, index } = group[i];
    const result = parallelResults[i];
    if (!result) {
      const singleResult = await executeSingleTool(call, executor, ctx, callbacksOrInput, auditWriter);
      safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, makeToolUseId(call.id), singleResult), callbacks, aw);
      results.set(index, toToolResultBlock(makeToolUseId(call.id), singleResult));
      continue;
    }
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, makeToolUseId(call.id), result), callbacks, aw);
    results.set(index, toToolResultBlock(makeToolUseId(call.id), result));
  }
}

async function executeReadonlySync(
  group: { call: ToolUseBlock; index: number }[],
  executor: IToolExecutor,
  ctx: ExecContext,
  results: Map<number, ToolResultBlock>,
  callbacksOrInput?: StepCallbacks | StepInput,
  auditWriter?: AuditLog,
): Promise<void> {
  if (group.length === 0) return;

  const { callbacks, auditWriter: aw } = resolveCallbacksAndAudit(callbacksOrInput, auditWriter);

  const batch = group.map(({ call }) => {
    const { async: _asyncMode, ...toolArgs } = call.input;
    return { toolName: call.name, args: toolArgs };
  });

  const parallelResults = await executor.executeParallel(batch, ctx);

  for (let i = 0; i < group.length; i++) {
    const { call, index } = group[i];
    const result = parallelResults[i];
    if (!result) {
      const singleResult = await executeSingleTool(call, executor, ctx, callbacksOrInput, auditWriter);
      safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, makeToolUseId(call.id), singleResult), callbacks, aw);
      results.set(index, toToolResultBlock(makeToolUseId(call.id), singleResult));
      continue;
    }
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, makeToolUseId(call.id), result), callbacks, aw);
    results.set(index, toToolResultBlock(makeToolUseId(call.id), result));
  }
}

async function executeWriteCalls(
  group: { call: ToolUseBlock; index: number }[],
  executor: IToolExecutor,
  ctx: ExecContext,
  results: Map<number, ToolResultBlock>,
  callbacksOrInput?: StepCallbacks | StepInput,
  auditWriter?: AuditLog,
): Promise<void> {
  const { callbacks, auditWriter: aw } = resolveCallbacksAndAudit(callbacksOrInput, auditWriter);
  // 注：onToolCall 已在 stream.ts:tool_use_start 时调
  for (const { call, index } of group) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    const result = await executeSingleTool(call, executor, ctx, callbacksOrInput, auditWriter);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, makeToolUseId(call.id), result), callbacks, aw);
    results.set(index, toToolResultBlock(makeToolUseId(call.id), result));
  }
}

export async function executeToolCalls(
  toolCalls: ToolUseBlock[],
  executor: IToolExecutor,
  ctx: ExecContext,
  registry: ToolRegistry | undefined,
  callbacksOrInput?: StepCallbacks | StepInput,
  auditWriter?: AuditLog,
): Promise<ToolResultBlock[]> {
  if (!registry) return executeSequential(toolCalls, executor, ctx, callbacksOrInput, auditWriter);

  const { readonlyAsync, readonlySync, write } = categorizeToolCalls(toolCalls, registry);
  const results = new Map<number, ToolResultBlock>();

  await executeReadonlyAsync(readonlyAsync, executor, ctx, results, callbacksOrInput, auditWriter);
  await executeReadonlySync(readonlySync, executor, ctx, results, callbacksOrInput, auditWriter);
  await executeWriteCalls(write, executor, ctx, results, callbacksOrInput, auditWriter);

  return toolCalls.map((_, i) => {
    const r = results.get(i);
    if (!r) {
      const violationMsg = `Missing result for tool call at index ${i}`;
      const aw = resolveCallbacksAndAudit(callbacksOrInput, auditWriter).auditWriter;
      aw?.write(
        STEP_EXECUTOR_AUDIT_EVENTS.INVARIANT_VIOLATION,
        `site=tool-execution.ts:164`,
        `kind=missing_tool_result`,
        `index=${i}`,
        `msg=${violationMsg}`,
      );
      throw new Error(`[INVARIANT VIOLATION] step-executor: ${violationMsg}`);
    }
    return r;
  });
}

export async function executeSingleTool(
  toolCall: ToolUseBlock,
  executor: IToolExecutor,
  ctx: ExecContext,
  callbacksOrInput?: StepCallbacks | StepInput,
  auditWriter?: AuditLog,
): Promise<ToolResult> {
  const { callbacks, auditWriter: aw } = resolveCallbacksAndAudit(callbacksOrInput, auditWriter);
  // 前置守卫：流中断时 toolCall.input 可能不完整（required 字段缺失）
  // 同步校验，不进入 async execute，避免与 abort 竞态导致 tool_result 丢失
  const schema = executor.getToolSchema?.(toolCall.name);
  if (schema?.required && Array.isArray(schema.required)) {
    const missing = schema.required.filter(f => !(f in (toolCall.input || {})));
    if (missing.length > 0) {
      const missingMsg = `incomplete tool_use: missing required [${missing.join(', ')}] (stream aborted mid-tool_use)`;
      safeCallback(
        'onToolInputParseError',
        () => callbacks?.onToolInputParseError?.(
          toolCall.name,
          makeToolUseId(toolCall.id),
          missingMsg,
        ),
        callbacks,
        aw,
      );
      aw?.write(
        STEP_EXECUTOR_AUDIT_EVENTS.TOOL_INPUT_PARSE_FAILED,
        toolCall.name,
        makeToolUseId(toolCall.id),
        `reason=parse_error`,
        `summary=${aw?.message(missingMsg) ?? missingMsg}`,
      );
      return {
        success: false,
        content: `[IncompleteToolUse] 工具调用参数不完整：缺少 ${missing.join(', ')}。可能由流中断导致。`,
      };
    }
  }

  // phase 1411: fire onToolCallInput after parse-failure guard, before execute.
  // SubAgent listens and emits `tool_call_input` index row (typed emit).
  safeCallback(
    'onToolCallInput',
    () => callbacks?.onToolCallInput?.(toolCall.name, makeToolUseId(toolCall.id), toolCall.input),
    callbacks,
    aw,
  );

  try {
    // async is NOT a universal meta-parameter — some tools (spawn) use it as
    // an internal parameter. Only readonly tools with supportsAsync use
    // executor-level async dispatch, and they go through executeReadonlyAsync.
    return await executor.execute({
      toolName: toolCall.name,
      args: toolCall.input,
      ctx,
      toolUseId: makeToolUseId(toolCall.id),
      timeoutMs: toSafeNumber(toolCall.input?.timeoutMs),
    });
  } catch (err) {
    const errorType = err instanceof Error ? err.constructor.name : 'Error';
    const errorMsg = formatErr(err);
    safeCallback(
      'onToolExecutionFailed',
      () => callbacks?.onToolExecutionFailed?.(toolCall.name, makeToolUseId(toolCall.id), errorType, errorMsg),
      callbacks,
      aw,
    );
    aw?.write(
      STEP_EXECUTOR_AUDIT_EVENTS.TOOL_EXECUTION_FAILED,
      toolCall.name,
      makeToolUseId(toolCall.id),
      `errorType=${errorType}`,
      `errorMsg=${aw?.message(errorMsg) ?? errorMsg}`,
    );
    return {
      success: false,
      content: `[${errorType}] 工具执行失败: ${errorMsg}`,
    };
  }
}
