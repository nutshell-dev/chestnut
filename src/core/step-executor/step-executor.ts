/**
 * Step Executor - Single-step LLM call + tool execution
 *
 * Extracted from loop.ts. Executes one LLM turn:
 * 1. Stream LLM response
 * 2. If tool_use: execute tools, append results, return continue
 * 3. If end_turn: return final
 * 4. Handle max_tokens truncation (text or tool_use)
 * 5. Handle context window exceeded
 *
 * Internal physical sub-files:
 * - types.ts          5 type/interface
 * - utils.ts          callback safety + content extract + parseToolInput + toToolResultBlock
 * - stream.ts         StreamState + 7 stream function
 * - tool-execution.ts categorize + 4 strategy + executeToolCalls + executeSingleTool
 * - stop-handlers.ts  handleToolUseStop + handleMaxTokensStop
 *
 * This file keeps executeStep entry point + runLLMCall LLM call layer
 */

import type { LLMResponse } from '../../foundation/llm-provider/index.js';
import type { LLMOrchestrator, LLMCallOptions } from '../../foundation/llm-orchestrator/index.js';
import type { StepInput, StepResult, LLMCallInfo } from './types.js';
import { asFinalStopReason } from './types.js';

import { throwAbortError } from './abort-helpers.js';
import { safeCallback, extractText, appendAssistantMessage } from './utils.js';
import { collectStreamResponse } from './llm-stream-collector.js';
import { handleToolUseStop, handleMaxTokensStop } from './stop-handlers.js';

// phase 690: 撤 proactive trim — L3 → L4 反向 dep 消除。
// reactive overflow trim 上提到 L5 Runtime 的 _runReact 反应式 retry 路径。
// turn 入口 proactive trim 仍归 Runtime (L5 → L4 顺向)。

export async function executeStep(input: StepInput): Promise<StepResult> {
  const { messages, systemPrompt, llm, tools, ctx, callbacks } = input;
  const maxTokens = input.maxTokens;

  if (ctx.signal?.aborted) throwAbortError(ctx.signal);
  // phase 1857 Step F (SE-D6): [B:safe][提交通知] 既有契约（phase 890 reverse 锁定：
  // throw 不中断 step）保持 safeCallback 包裹；计划基线曾议 S 级，经判为偏差并登记。
  safeCallback('onBeforeLLMCall', () => callbacks?.onBeforeLLMCall?.(), callbacks, input.eventSink);

  const llmStartTime = Date.now();
  const callOptions: LLMCallOptions = {
    messages,
    system: systemPrompt,
    tools,
    maxTokens,
    signal: ctx.signal, streamIdleTimeoutMs: input.idleTimeoutMs,
  };
  const { response, llmInfo } = await runLLMCall(llm, callOptions, llmStartTime, input);

  if (response.content.length === 0) {
    // phase 1857 Step I (SE-D9): 裁决事实经单一事件出口（展示+持久化归 caller adapter）
    input.eventSink?.llmEmptyResponse({ stopReason: response.stop_reason });
  }

  if (response.stop_reason === 'tool_use') return await handleToolUseStop(response, input, llmInfo);

  if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop') {
    const text = extractText(response.content);
    appendAssistantMessage(messages, response.content);
    safeCallback('onMessageAppended', () => callbacks?.onMessageAppended?.('assistant', response.content.length), callbacks, input.eventSink);
    return { kind: 'final', stopReason: asFinalStopReason(response.stop_reason), finalText: text };
  }

  if (response.stop_reason === 'max_tokens') return handleMaxTokensStop(response, input, llmInfo, maxTokens);

  // phase 324 C6: 显式 'content_filter' API 值 → 保留为 'content_filter'；
  // 其他未识别（refusal / safety / stop_sequence / 新出 SDK 值）→ 'unknown'。
  if (response.stop_reason === 'content_filter') {
    const text = extractText(response.content);
    appendAssistantMessage(messages, response.content);
    safeCallback('onMessageAppended', () => callbacks?.onMessageAppended?.('assistant', response.content.length), callbacks, input.eventSink);
    return { kind: 'final', stopReason: asFinalStopReason('content_filter'), finalText: text };
  }

  // phase 1857 Step I (SE-D9): 单一事件出口
  input.eventSink?.llmUnknownStopReason({ stopReason: response.stop_reason });
  const text = extractText(response.content);
  appendAssistantMessage(messages, response.content);
  safeCallback('onMessageAppended', () => callbacks?.onMessageAppended?.('assistant', response.content.length), callbacks, input.eventSink);
  return { kind: 'final', stopReason: asFinalStopReason('unknown'), finalText: text };
}

async function runLLMCall(
  llm: LLMOrchestrator,
  callOptions: LLMCallOptions,
  llmStartTime: number,
  input: StepInput,
): Promise<{ response: LLMResponse; llmInfo: LLMCallInfo }> {
  const { callbacks } = input;
  let response: LLMResponse;
  try {
    response = await collectStreamResponse(llm, callOptions, callbacks, input.eventSink);
  } catch (err) {
    const info: LLMCallInfo = {
      model: llm.getProviderInfo?.()?.model ?? 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - llmStartTime,
      error: err instanceof Error
        ? err.message
        : (typeof err === 'object' && err !== null
            ? JSON.stringify(err, Object.getOwnPropertyNames(err))
            : String(err)),
    };
    // phase 1857 Step F (SE-D6): [S:strict][提交通知] 唯一 S 级——副作用提交前调用事实交付；
    // 现状即裸调，失败传播、可中止 step（原错在 error 路径保留并 rethrow）
    callbacks?.onLLMResult?.(info);
    throw err;
  }
  const llmInfo: LLMCallInfo = {
    model: llm.getProviderInfo?.()?.model ?? 'unknown',
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    latencyMs: Date.now() - llmStartTime,
  };
  // phase 1857 Step F (SE-D6): [S:strict][提交通知] 唯一 S 级——副作用提交前调用事实交付；
  // 现状即裸调，失败传播、可中止 step
  callbacks?.onLLMResult?.(llmInfo);
  return { response, llmInfo };
}
