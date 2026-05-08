/**
 * @module L3.StepExecutor.StopHandlers
 * Stop reason handlers — tool_use + max_tokens
 */

import type { LLMResponse } from '../../types/message.js';
import type { ToolResultBlock } from '../../types/message.js';
import type { StepInput, StepResult, LLMCallInfo } from './types.js';
import { extractText, extractToolCalls, appendAssistantMessage, appendToolResults } from './utils.js';
import { executeToolCalls } from './tool-execution.js';
import { throwAbortError } from './abort-helpers.js';
// import { cloneExecContext } from '../../foundation/tools/context.js';

export async function handleToolUseStop(
  response: LLMResponse,
  input: StepInput,
  llmInfo: LLMCallInfo,
): Promise<StepResult> {
  const { messages, executor, registry, ctx, callbacks } = input;
  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length === 0) {
    const text = extractText(response.content);
    appendAssistantMessage(messages, response.content);
    if (callbacks?.onUnparseableToolUse) callbacks.onUnparseableToolUse(response.stop_reason);
    else console.warn(`[step-executor] LLM returned tool_use stop_reason but no parseable tool calls, treating as no_tool`);
    return { kind: 'final', stopReason: 'no_tool', finalText: text };
  }
  appendAssistantMessage(messages, response.content);

  let parseErrorCount = 0;
  const trackingCallbacks: import('./types.js').StepCallbacks = {
    ...callbacks,
    onToolResult: (name, id, result) => {
      if (result.metadata?.parseError === true) parseErrorCount++;
      callbacks?.onToolResult?.(name, id, result);
    },
  };
  // abort 期不剥 signal / 工具自治响应 / 已 abort-aware 工具 throw / 不 aware 工具忽略
  const toolResults = await executeToolCalls(toolCalls, executor, ctx, registry, trackingCallbacks);

  if (ctx.signal?.aborted) throwAbortError(ctx.signal);
  appendToolResults(messages, toolResults);

  return {
    kind: 'continue',
    meta: {
      toolCallCount: toolCalls.length,
      parseErrorCount,
      allParseErrors: toolCalls.length > 0 && parseErrorCount === toolCalls.length,
      llm: llmInfo,
    },
  };
}

export function handleMaxTokensStop(
  response: LLMResponse,
  input: StepInput,
  llmInfo: LLMCallInfo,
  maxTokens: number,
): StepResult {
  const { messages } = input;
  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length > 0) {
    appendAssistantMessage(messages, response.content);
    const truncatedResults: ToolResultBlock[] = toolCalls.map(tc => ({
      type: 'tool_result' as const,
      tool_use_id: tc.id,
      content: `[TRUNCATED] 输出超过单次 token 上限（${maxTokens} tokens），工具调用被截断未执行。请将内容拆分为多次较小的调用。`,
      is_error: true,
    }));
    appendToolResults(messages, truncatedResults);
    return {
      kind: 'max_tokens_tool_use',
      meta: {
        toolCallCount: toolCalls.length,
        parseErrorCount: 0,
        allParseErrors: false,
        llm: llmInfo,
      },
    };
  }
  const text = extractText(response.content);
  appendAssistantMessage(messages, response.content);
  return {
    kind: 'final',
    stopReason: 'max_tokens_text',
    finalText: text + '\n\n[Response truncated due to length limit]',
  };
}
