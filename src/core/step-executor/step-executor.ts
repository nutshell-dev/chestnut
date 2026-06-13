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

import type { LLMResponse, Message } from '../../foundation/llm-provider/types.js';
import type { LLMOrchestrator, LLMCallOptions } from '../../foundation/llm-orchestrator/index.js';
import type { StepInput, StepResult, LLMCallInfo } from './types.js';
import { asFinalStopReason } from './types.js';

import type { StepCallbacks } from './types.js';
import { throwAbortError } from './abort-helpers.js';
import { safeCallback, extractText, appendAssistantMessage } from './utils.js';
import { collectStreamResponse } from './llm-stream-collector.js';
import { handleToolUseStop, handleMaxTokensStop } from './stop-handlers.js';
import {
  computeBudget,
  handleContextExceeded,
  type LLMCallView,
} from '../l4_context_manager/index.js';
import { estimateTextTokens, estimateInputTokens } from '../../foundation/llm-provider/token-estimator.js';

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-3-7-sonnet-20250219': 200_000,
  'gpt-4o': 128_000,
  'deepseek-chat': 64_000,
  'kimi-k2.5': 256_000,
  'MiniMax-M1': 1_000_000,
  'gemini-2.5-pro-preview-03-25': 1_000_000,
  'llama3.1': 128_000,
  'grok-4': 128_000,
  'openai/gpt-4o': 128_000,
  'anthropic/claude-sonnet-4-5': 200_000,
  'glm-4.6': 128_000,
  'qwen-coder-plus-latest': 128_000,
};

export async function executeStep(input: StepInput): Promise<StepResult> {
  const { messages, systemPrompt, llm, tools, ctx, callbacks } = input;
  const maxTokens = input.maxTokens;

  if (ctx.signal?.aborted) throwAbortError(ctx.signal);
  safeCallback('onBeforeLLMCall', () => callbacks?.onBeforeLLMCall?.(), callbacks);

  // Phase 186: context budget + trim before LLM call
  const providerInfo = llm.getProviderInfo?.();
  const providerContextWindow = providerInfo?.model
    ? (MODEL_CONTEXT_WINDOWS[providerInfo.model] ?? 128_000)
    : 128_000;

  const budget = computeBudget({
    providerContextWindow,
    reserveOutputTokens: maxTokens ?? 0,
    systemPromptTokens: estimateTextTokens(systemPrompt),
    toolsForLLMTokens: estimateTextTokens(JSON.stringify(tools ?? [])),
  });

  // trim 触发：产出 LLM call payload view、不替换 messages（caller 持久化引用、append 仍走 messages）
  let callView: LLMCallView = { messages, wasTrimmed: false };
  if (budget.available > 0 && estimateInputTokens({ messages, systemPrompt, tools }).total > budget.available) {
    callView = handleContextExceeded(messages, systemPrompt, budget.available);
  }

  const llmStartTime = Date.now();
  const callOptions: LLMCallOptions = {
    messages: callView.messages as Message[],
    system: systemPrompt,
    tools,
    maxTokens,
    signal: ctx.signal, streamIdleTimeoutMs: input.idleTimeoutMs,
  };
  const { response, llmInfo } = await runLLMCall(llm, callOptions, llmStartTime, callbacks);

  if (response.content.length === 0) {
    callbacks?.onEmptyResponse?.(response.stop_reason);
  }

  if (response.stop_reason === 'tool_use') return handleToolUseStop(response, input, llmInfo);

  if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop') {
    const text = extractText(response.content);
    appendAssistantMessage(messages, response.content);
    callbacks?.onMessageAppended?.('assistant', response.content.length);
    return { kind: 'final', stopReason: asFinalStopReason(response.stop_reason), finalText: text };
  }

  if (response.stop_reason === 'max_tokens') return handleMaxTokensStop(response, input, llmInfo, maxTokens);

  // phase 324 C6: 显式 'content_filter' API 值 → 保留为 'content_filter'；
  // 其他未识别（refusal / safety / stop_sequence / 新出 SDK 值）→ 'unknown'。
  // 旧码把全部未识别 stop_reason 都折叠到 'content_filter'，下游 loop.ts:138-146
  // mapStopReason 期望两桶分立（phase 1483 / phase 788 锚）。
  if (response.stop_reason === 'content_filter') {
    const text = extractText(response.content);
    appendAssistantMessage(messages, response.content);
    callbacks?.onMessageAppended?.('assistant', response.content.length);
    return { kind: 'final', stopReason: asFinalStopReason('content_filter'), finalText: text };
  }

  callbacks?.onUnknownStopReason?.(response.stop_reason);
  const text = extractText(response.content);
  appendAssistantMessage(messages, response.content);
  callbacks?.onMessageAppended?.('assistant', response.content.length);
  return { kind: 'final', stopReason: asFinalStopReason('unknown'), finalText: text };
}

async function runLLMCall(
  llm: LLMOrchestrator,
  callOptions: LLMCallOptions,
  llmStartTime: number,
  callbacks?: StepCallbacks,
): Promise<{ response: LLMResponse; llmInfo: LLMCallInfo }> {
  let response: LLMResponse;
  try {
    response = await collectStreamResponse(llm, callOptions, callbacks);
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
    callbacks?.onLLMResult?.(info);
    throw err;
  }
  const llmInfo: LLMCallInfo = {
    model: llm.getProviderInfo?.()?.model ?? 'unknown',
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    latencyMs: Date.now() - llmStartTime,
  };
  callbacks?.onLLMResult?.(llmInfo);
  return { response, llmInfo };
}
