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

import type { LLMResponse } from '../../types/message.js';
import type { LLMOrchestrator, LLMCallOptions } from '../../foundation/llm-orchestrator/index.js';
import type { StepInput, StepResult, LLMCallInfo } from './types.js';
export type { LLMCallInfo, StepCallbacks, StepInput, StepMeta, StepResult } from './types.js';
import type { StepCallbacks } from './types.js';
import { REACT_DEFAULT_MAX_TOKENS } from '../agent-executor/constants.js';
import { throwAbortError } from './abort-helpers.js';
import { safeCallback, extractText, appendAssistantMessage } from './utils.js';
import { collectStreamResponse } from './stream.js';
import { handleToolUseStop, handleMaxTokensStop } from './stop-handlers.js';

export async function executeStep(input: StepInput): Promise<StepResult> {
  const { messages, systemPrompt, llm, tools, ctx, callbacks } = input;
  const maxTokens = input.maxTokens ?? REACT_DEFAULT_MAX_TOKENS;

  if (ctx.signal?.aborted) throwAbortError(ctx.signal);
  safeCallback('onBeforeLLMCall', () => callbacks?.onBeforeLLMCall?.(), callbacks);

  const llmStartTime = Date.now();
  const callOptions: LLMCallOptions = {
    messages, system: systemPrompt, tools, maxTokens,
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
    return { kind: 'final', stopReason: 'end_turn', finalText: text };
  }

  if (response.stop_reason === 'max_tokens') return handleMaxTokensStop(response, input, llmInfo, maxTokens);

  callbacks?.onUnknownStopReason?.(response.stop_reason);
  const text = extractText(response.content);
  appendAssistantMessage(messages, response.content);
  return { kind: 'final', stopReason: 'unknown', finalText: text };
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
