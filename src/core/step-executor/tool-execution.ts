/**
 * @module L3.StepExecutor.ToolExecution
 * Tool execution strategies — categorize + 3 parallel strategy + sequential / single
 *
 * 3 strategies:
 * - executeSequential: 无 registry 时串行
 * - executeReadonlyParallel: 只读工具并行
 * - executeWriteCalls: 写工具串行
 */

import type { ToolUseBlock, ToolResultBlock } from '../../foundation/llm-provider/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import type { ExecContext } from '../../foundation/tools/index.js';
import { ToolError } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { StepInput, StepCallbacks } from './types.js';
import { ToolResultDeliveryError, type RecoveryDelivery } from './recovery-delivery.js';
import type { StepExecutorEventSink } from './audit-sink.js';
import { safeCallback, toToolResultBlock } from './utils.js';
import { throwAbortError, type AbortExecutionEvidence } from './abort-helpers.js';

import { makeToolUseId } from '../../foundation/llm-provider/index.js';



function toSafeNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isNaN(n) || !Number.isFinite(n) ? undefined : n;
}

interface CategorizedCalls {
  readonly: { call: ToolUseBlock; index: number }[];
  write: { call: ToolUseBlock; index: number }[];
}

function categorizeToolCalls(
  toolCalls: ToolUseBlock[],
  registry: ToolRegistry,
): CategorizedCalls {
  const readonly: { call: ToolUseBlock; index: number }[] = [];
  const write: { call: ToolUseBlock; index: number }[] = [];

  for (const [i, call] of toolCalls.entries()) {
    const tool = registry.get(call.name);
    if (tool?.readonly === true) {
      readonly.push({ call, index: i });
    } else {
      write.push({ call, index: i });
    }
  }
  return { readonly, write };
}

function isStepInput(value: StepCallbacks | StepInput): value is StepInput {
  return 'messages' in value;
}

/**
 * Phase 1956 Step D：工具结果事实提交（execute 返回后即刻）。
 * 提交失败 = recovery delivery failure：工具副作用已发生、不可重跑，
 * 抛出 typed ToolResultDeliveryError（携带 toolUseId）——不吞成 ToolError、
 * 不伪装成工具业务失败、不标为未执行。
 */
async function commitToolResultFact(
  recovery: RecoveryDelivery,
  call: ToolUseBlock,
  result: ToolResult,
): Promise<void> {
  try {
    await recovery.toolResultCommitted({
      toolUseId: makeToolUseId(call.id),
      toolName: call.name,
      result,
      resultAtMs: Date.now(),
    });
  } catch (err) {
    throw new ToolResultDeliveryError(
      { toolUseId: makeToolUseId(call.id), toolName: call.name },
      err,
    );
  }
}

// Phase 1933 Step C: 从 callbacksOrInput 取严格恢复交付通道（仅 StepInput 本体携带；
// resolveCallbacksAndSink 不返回 input 本体，故就地窄化）。
function resolveRecovery(callbacksOrInput?: StepCallbacks | StepInput): RecoveryDelivery | undefined {
  return callbacksOrInput && isStepInput(callbacksOrInput) ? callbacksOrInput.recovery : undefined;
}

function resolveCallbacksAndSink(
  callbacksOrInput?: StepCallbacks | StepInput,
  eventSink?: StepExecutorEventSink,
): { callbacks?: StepCallbacks; eventSink?: StepExecutorEventSink } {
  if (callbacksOrInput && isStepInput(callbacksOrInput)) {
    return { callbacks: callbacksOrInput.callbacks, eventSink: callbacksOrInput.eventSink ?? eventSink };
  }
  return { callbacks: callbacksOrInput, eventSink };
}

async function executeSequential(
  toolCalls: ToolUseBlock[],
  executor: IToolExecutor,
  ctx: ExecContext,
  callbacksOrInput?: StepCallbacks | StepInput,
  eventSink?: StepExecutorEventSink,
): Promise<ToolResultBlock[]> {
  const { callbacks, eventSink: sink } = resolveCallbacksAndSink(callbacksOrInput, eventSink);
  // 注：onToolCall 已在 stream.ts:tool_use_start 时调（流式提前 emit / 不等 execute）
  const results: ToolResultBlock[] = [];
  // phase 1857 Step G (SE-D7): 批内已完成证据——abort 时随终止载体交付（已执行未提交可证明）
  const completed: AbortExecutionEvidence['completed'] = [];
  for (const call of toolCalls) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal, sink, { completed });
    const result = await executeSingleTool(call, executor, ctx, callbacksOrInput, eventSink);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, makeToolUseId(call.id), result), callbacks, sink);
    results.push(toToolResultBlock(makeToolUseId(call.id), result));
    completed.push({ toolName: call.name, toolUseId: makeToolUseId(call.id), success: result.success });
  }
  return results;
}

async function executeReadonlyParallel(
  group: { call: ToolUseBlock; index: number }[],
  executor: IToolExecutor,
  ctx: ExecContext,
  results: Map<number, ToolResultBlock>,
  callbacksOrInput?: StepCallbacks | StepInput,
  eventSink?: StepExecutorEventSink,
): Promise<void> {
  if (group.length === 0) return;

  const { callbacks, eventSink: sink } = resolveCallbacksAndSink(callbacksOrInput, eventSink);
  const recovery = resolveRecovery(callbacksOrInput);

  const batch = group.map(({ call }) => {
    const { async: _, ...toolArgs } = call.input;
    return { toolName: call.name, args: toolArgs };
  });

  // Phase 1933 Step C: 批路径绕过 executeSingleTool——executeParallel 副作用前
  // 按组内顺序逐个 await 提交 started 事实；任一失败传播，批不得发出。
  if (recovery) {
    for (const { call } of group) {
      await recovery.toolStarted({
        toolUseId: makeToolUseId(call.id),
        toolName: call.name,
        input: call.input,
        startedAtMs: Date.now(),
      });
    }
  }

  const parallelResults = await executor.executeParallel(batch, ctx);

  for (let i = 0; i < group.length; i++) {
    const { call, index } = group[i];
    const result = parallelResults[i];
    if (!result) {
      // fallback 走 executeSingleTool——started/result 事实由 executeSingleTool 自身提交，此处不重复提交
      const singleResult = await executeSingleTool(call, executor, ctx, callbacksOrInput, eventSink);
      safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, makeToolUseId(call.id), singleResult), callbacks, sink);
      results.set(index, toToolResultBlock(makeToolUseId(call.id), singleResult));
      continue;
    }
    // Phase 1933 Step C: 批内实际结果按组内顺序逐个 await 提交；失败传播（副作用已发生，不重试）
    // Phase 1956 Step D: 提交失败包成 typed delivery failure（不可重跑）。
    if (recovery) {
      await commitToolResultFact(recovery, call, result);
    }
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, makeToolUseId(call.id), result), callbacks, sink);
    results.set(index, toToolResultBlock(makeToolUseId(call.id), result));
  }
}

async function executeWriteCalls(
  group: { call: ToolUseBlock; index: number }[],
  executor: IToolExecutor,
  ctx: ExecContext,
  results: Map<number, ToolResultBlock>,
  callbacksOrInput?: StepCallbacks | StepInput,
  eventSink?: StepExecutorEventSink,
): Promise<void> {
  const { callbacks, eventSink: sink } = resolveCallbacksAndSink(callbacksOrInput, eventSink);
  // 注：onToolCall 已在 stream.ts:tool_use_start 时调
  // phase 1857 Step G (SE-D7): 写组批内已完成证据
  const completed: AbortExecutionEvidence['completed'] = [];
  for (const { call, index } of group) {
    if (ctx.signal?.aborted) throwAbortError(ctx.signal, sink, { completed });
    const result = await executeSingleTool(call, executor, ctx, callbacksOrInput, eventSink);
    safeCallback('onToolResult', () => callbacks?.onToolResult?.(call.name, makeToolUseId(call.id), result), callbacks, sink);
    results.set(index, toToolResultBlock(makeToolUseId(call.id), result));
    completed.push({ toolName: call.name, toolUseId: makeToolUseId(call.id), success: result.success });
  }
}

export async function executeToolCalls(
  toolCalls: ToolUseBlock[],
  executor: IToolExecutor,
  ctx: ExecContext,
  registry: ToolRegistry | undefined,
  callbacksOrInput?: StepCallbacks | StepInput,
  eventSink?: StepExecutorEventSink,
): Promise<ToolResultBlock[]> {
  if (!registry) return executeSequential(toolCalls, executor, ctx, callbacksOrInput, eventSink);

  const { readonly, write } = categorizeToolCalls(toolCalls, registry);
  const results = new Map<number, ToolResultBlock>();

  await executeReadonlyParallel(readonly, executor, ctx, results, callbacksOrInput, eventSink);
  await executeWriteCalls(write, executor, ctx, results, callbacksOrInput, eventSink);

  return toolCalls.map((_, i) => {
    const r = results.get(i);
    if (!r) {
      const violationMsg = `Missing result for tool call at index ${i}`;
      const sink = resolveCallbacksAndSink(callbacksOrInput, eventSink).eventSink;
      // phase 1857 Step I (SE-D9): 纯审计行经单一事件出口
      sink?.invariantViolation({
        site: 'tool-execution.ts:164',
        kind: 'missing_tool_result',
        index: i,
        msg: violationMsg,
      });
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
  eventSink?: StepExecutorEventSink,
): Promise<ToolResult> {
  const { callbacks, eventSink: sink } = resolveCallbacksAndSink(callbacksOrInput, eventSink);
  // 前置守卫：流中断时 toolCall.input 可能不完整（required 字段缺失）
  // 同步校验，不进入 async execute，避免与 abort 竞态导致 tool_result 丢失
  const schema = executor.getToolSchema?.(toolCall.name);
  if (schema?.required && Array.isArray(schema.required)) {
    const missing = schema.required.filter(f => !(f in (toolCall.input || {})));
    if (missing.length > 0) {
      const missingMsg = `incomplete tool_use: missing required [${missing.join(', ')}] (stream aborted mid-tool_use)`;
      // phase 1857 Step I (SE-D9): 裁决事实经单一事件出口
      sink?.toolInputParseFailed({
        toolName: toolCall.name,
        toolUseId: makeToolUseId(toolCall.id),
        reason: 'parse_error',
        summary: missingMsg,
      });
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
    sink,
  );

  // Phase 1933 Step C: 严格恢复交付——executor.execute 副作用前 await 提交 started 事实；
  // 失败传播，工具不得执行（无副作用发生）。
  const recovery = resolveRecovery(callbacksOrInput);
  if (recovery) {
    await recovery.toolStarted({
      toolUseId: makeToolUseId(toolCall.id),
      toolName: toolCall.name,
      input: toolCall.input,
      startedAtMs: Date.now(),
    });
  }

  let result: ToolResult;
  try {
    // async is NOT a universal meta-parameter — some tools (spawn) use it as
    // an internal parameter.
    result = await executor.execute({
      toolName: toolCall.name,
      args: toolCall.input,
      ctx,
      toolUseId: makeToolUseId(toolCall.id),
      timeoutMs: toSafeNumber(toolCall.input?.timeoutMs),
    });
  } catch (err) {
    // phase 1857 Step H (SE-D8): 只收敛 Tools 公开声明的可呈现执行失败（ToolError/ToolTimeoutError）；
    // 控制信号（StepAbortError）与系统故障（invariant / TypeError 等）保持原语义 rethrow，
    // 不被业务化为 ToolResult。前置核（1857 Step H §7）：现存工具实现的可呈现失败均以
    // { success:false } ToolResult 表达、无 plain-Error 工具面需 ToolError 化。
    if (!(err instanceof ToolError)) throw err;
    const errorType = err.name;
    const errorMsg = formatErr(err);
    // phase 1857 Step I (SE-D9): 裁决事实经单一事件出口
    sink?.toolExecutionFailed({
      toolName: toolCall.name,
      toolUseId: makeToolUseId(toolCall.id),
      errorType,
      errorMsg,
    });
    return {
      success: false,
      content: `[${errorType}] 工具执行失败: ${errorMsg}`,
    };
  }

  // Phase 1933 Step C: 严格恢复交付——execute 返回后即刻 await 提交 result 事实。
  // 提交失败传播（中止 step）：工具副作用已发生不可撤销，started 事实保持不确定、
  // 不得重标为未开始、不重试（恢复语义归实现方）。
  // Phase 1956 Step D: 提交失败包成 typed ToolResultDeliveryError（不可重跑）。
  // 注意放在 try 外：recovery 提交失败不走 ToolError 收敛路径。
  if (recovery) {
    await commitToolResultFact(recovery, toolCall, result);
  }
  return result;
}
