/**
 * @module L3.StepExecutor.StopHandlers
 * Stop reason handlers — tool_use + max_tokens
 */

import type { LLMResponse } from '../../foundation/llm-provider/types.js';
import type { ToolResultBlock } from '../../foundation/llm-provider/types.js';
import type { StepInput, StepResult, LLMCallInfo } from './types.js';
import { extractText, extractToolCalls, appendAssistantMessage, appendToolResults } from './utils.js';
import { executeToolCalls } from './tool-execution.js';
import { throwAbortError } from './abort-helpers.js';

export async function handleToolUseStop(
  response: LLMResponse,
  input: StepInput,
  llmInfo: LLMCallInfo,
): Promise<StepResult> {
  const { messages, executor, registry, ctx, callbacks } = input;
  const toolCalls = extractToolCalls(response.content);
  const prebuiltResults = response.content.filter(
    (b): b is ToolResultBlock => b.type === 'tool_result'
  );

  if (toolCalls.length === 0 && prebuiltResults.length === 0) {
    const text = extractText(response.content);
    appendAssistantMessage(messages, response.content);
    callbacks?.onUnparseableToolUse?.(response.stop_reason);
    return { kind: 'final', stopReason: 'no_tool', finalText: text };
  }
  appendAssistantMessage(messages, response.content.filter(b => b.type !== 'tool_result'));

  let newParseErrorCount = 0;
  const trackingCallbacks: import('./types.js').StepCallbacks = {
    ...callbacks,
    onUnparseableToolUse: callbacks ? callbacks.onUnparseableToolUse : () => {},
    onToolResult: (name, id, result) => {
      if (result.metadata?.parseError === true) newParseErrorCount++;
      callbacks?.onToolResult?.(name, id, result);
    },
  };
  // abort 期不剥 signal / 工具自治响应 / 已 abort-aware 工具 throw / 不 aware 工具忽略
  const toolResults = await executeToolCalls(toolCalls, executor, ctx, registry, trackingCallbacks);

  if (ctx.signal?.aborted) throwAbortError(ctx.signal);
  appendToolResults(messages, [...prebuiltResults, ...toolResults]);

  const totalToolCallCount = toolCalls.length + prebuiltResults.length;
  const totalParseErrorCount = prebuiltResults.length + newParseErrorCount;

  // Extract tool names from stream-layer parse-error results for error messages
  const toolNames = prebuiltResults
    .map(pr => {
      const m = pr.content.match(/^Tool input JSON parse failed for "([^"]+)"/);
      return m ? m[1] : '';
    })
    .filter(Boolean)
    .join(', ');

  return {
    kind: 'continue',
    meta: {
      toolCallCount: totalToolCallCount,
      parseErrorCount: totalParseErrorCount,
      allParseErrors: totalToolCallCount > 0 && totalParseErrorCount === totalToolCallCount,
      llm: llmInfo,
      toolNames: toolNames || undefined,
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
  const prebuiltResults = response.content.filter(
    (b): b is ToolResultBlock => b.type === 'tool_result'
  );
  if (toolCalls.length > 0 || prebuiltResults.length > 0) {
    appendAssistantMessage(messages, response.content.filter(b => b.type !== 'tool_result'));
    const allIds = [
      ...toolCalls.map(tc => tc.id),
      ...prebuiltResults.map(pr => pr.tool_use_id),
    ];
    const truncatedResults: ToolResultBlock[] = allIds.map(id => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      content: `[TRUNCATED] 输出超过单次 token 上限（${maxTokens} tokens），工具调用被截断未执行。请将内容拆分为多次较小的调用。`,
      is_error: true,
    }));
    appendToolResults(messages, truncatedResults);
    return {
      kind: 'max_tokens_tool_use',
      meta: {
        toolCallCount: allIds.length,
        // parseErrorCount=0 by design: max_tokens_tool_use path 不走 parse error counting（continue 路径 own）
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
