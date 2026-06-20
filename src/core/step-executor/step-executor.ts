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
  trimAndPersist,
  CONTEXT_TRIM_RECENT_WINDOW_MS,
  CONTEXT_TRIM_TARGET_RATIO,
  CONTEXT_TRIM_PREVIEW_BYTES,
} from '../l4_context_manager/index.js';
import { estimateTextTokens, estimateMessagesTokens, estimateToolsTokens } from '../../foundation/llm-provider/index.js';
import { resolveContextWindow } from '../../foundation/llm-provider/model-context-windows.js';



export async function executeStep(input: StepInput): Promise<StepResult> {
  const { messages, systemPrompt, llm, tools, ctx, callbacks, dialogStore, contextManagerConfig } = input;
  const maxTokens = input.maxTokens;

  if (ctx.signal?.aborted) throwAbortError(ctx.signal);
  safeCallback('onBeforeLLMCall', () => callbacks?.onBeforeLLMCall?.(), callbacks);

  // phase 440: reactive overflow context trim
  let effectiveMessages = messages;
  let newMessagesFromTrim: Message[] | undefined;
  if (dialogStore && contextManagerConfig) {
    const providerInfo = llm.getProviderInfo?.();
    const providerContextWindow = resolveContextWindow(providerInfo?.model);

    const targetMessagesTokens = Math.floor(providerContextWindow * CONTEXT_TRIM_TARGET_RATIO)
      - estimateTextTokens(systemPrompt)
      - estimateToolsTokens(tools ?? []);

    const estimatedTokens = estimateMessagesTokens(messages);

    if (estimatedTokens > targetMessagesTokens) {
      const trimResult = await trimAndPersist({
        messages,
        systemPrompt,
        toolsForLLM: tools ?? [],
        contextWindow: providerContextWindow,
        recentWindowMs: CONTEXT_TRIM_RECENT_WINDOW_MS,
        targetRatio: CONTEXT_TRIM_TARGET_RATIO,
        previewBytes: CONTEXT_TRIM_PREVIEW_BYTES,
        filterSubtypes: contextManagerConfig.filterSubtypes,
        dialogStore,
        audit: ctx.auditWriter ?? { write: () => {} },
        triggerKind: 'reactive_overflow',
      });
      // caller 引用替换：mutate in-place so all upstream references stay in sync,
      // and surface explicit newMessages for callers that prefer explicit swap.
      messages.splice(0, messages.length, ...trimResult.newMessages);
      effectiveMessages = messages;
      newMessagesFromTrim = trimResult.newMessages;
    }
  }

  const llmStartTime = Date.now();
  const callOptions: LLMCallOptions = {
    messages: effectiveMessages,
    system: systemPrompt,
    tools,
    maxTokens,
    signal: ctx.signal, streamIdleTimeoutMs: input.idleTimeoutMs,
  };
  const { response, llmInfo } = await runLLMCall(llm, callOptions, llmStartTime, callbacks);

  if (response.content.length === 0) {
    callbacks?.onEmptyResponse?.(response.stop_reason);
  }

  if (response.stop_reason === 'tool_use') return { ...(await handleToolUseStop(response, input, llmInfo)), newMessages: newMessagesFromTrim };

  if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop') {
    const text = extractText(response.content);
    appendAssistantMessage(effectiveMessages, response.content);
    callbacks?.onMessageAppended?.('assistant', response.content.length);
    return { kind: 'final', stopReason: asFinalStopReason(response.stop_reason), finalText: text, newMessages: newMessagesFromTrim };
  }

  if (response.stop_reason === 'max_tokens') return { ...handleMaxTokensStop(response, input, llmInfo, maxTokens), newMessages: newMessagesFromTrim };

  // phase 324 C6: 显式 'content_filter' API 值 → 保留为 'content_filter'；
  // 其他未识别（refusal / safety / stop_sequence / 新出 SDK 值）→ 'unknown'。
  // 旧码把全部未识别 stop_reason 都折叠到 'content_filter'，下游 loop.ts:138-146
  // mapStopReason 期望两桶分立（phase 1483 / phase 788 锚）。
  if (response.stop_reason === 'content_filter') {
    const text = extractText(response.content);
    appendAssistantMessage(effectiveMessages, response.content);
    callbacks?.onMessageAppended?.('assistant', response.content.length);
    return { kind: 'final', stopReason: asFinalStopReason('content_filter'), finalText: text, newMessages: newMessagesFromTrim };
  }

  callbacks?.onUnknownStopReason?.(response.stop_reason);
  const text = extractText(response.content);
  appendAssistantMessage(effectiveMessages, response.content);
  callbacks?.onMessageAppended?.('assistant', response.content.length);
  return { kind: 'final', stopReason: asFinalStopReason('unknown'), finalText: text, newMessages: newMessagesFromTrim };
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
