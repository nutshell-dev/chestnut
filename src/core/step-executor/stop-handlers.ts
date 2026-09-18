/**
 * @module L3.StepExecutor.StopHandlers
 * Stop reason handlers — tool_use + max_tokens
 */

import type { LLMResponse } from '../../foundation/llm-provider/index.js';
import type { ToolResultBlock } from '../../foundation/llm-provider/index.js';
import type { StepInput, StepResult, LLMCallInfo } from './types.js';
import { asFinalStopReason } from './types.js';
import { extractText, extractToolCalls, appendAssistantMessage, appendToolResults, safeCallback } from './utils.js';
import { executeToolCalls } from './tool-execution.js';
import { STEP_EXECUTOR_AUDIT_EVENTS } from './audit-events.js';
import { throwAbortError } from './abort-helpers.js';
import { isToolInputParseError, parseToolInputErrorName } from './tool-input-parse-error.js';


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
    // phase 1857 Step F (SE-D6): [B:safe] 副作用已发生，通知失败不改变 step 终态
    safeCallback('onMessageAppended', () => callbacks?.onMessageAppended?.('assistant', response.content.length), callbacks, input.auditWriter);
    safeCallback('onUnparseableToolUse', () => callbacks?.onUnparseableToolUse?.(response.stop_reason), callbacks, input.auditWriter);
    input.auditWriter?.write(
      STEP_EXECUTOR_AUDIT_EVENTS.LLM_UNPARSEABLE_TOOL_USE,
      `stop_reason=${response.stop_reason}`,
    );
    return { kind: 'final', stopReason: asFinalStopReason('no_tool'), finalText: text };
  }
  appendAssistantMessage(messages, response.content.filter(b => b.type !== 'tool_result'));
  // phase 1857 Step F (SE-D6): [B:safe]
  safeCallback('onMessageAppended', () => callbacks?.onMessageAppended?.('assistant', response.content.filter(b => b.type !== 'tool_result').length), callbacks, input.auditWriter);

  let newParseErrorCount = 0;
  const trackingCallbacks: import('./types.js').StepCallbacks = {
    ...callbacks,
    onUnparseableToolUse: callbacks ? callbacks.onUnparseableToolUse : () => {},
    onToolResult: (name, id, result) => {
      if (result.metadata?.parseError === true) newParseErrorCount++;
      callbacks?.onToolResult?.(name, id, result);
    },
  };
  // phase 1282: prebuilt 已 cover 的 tool_use（stream-side parseError emit 占位）skip execute / 防 input={} 真跑出副作用
  const prebuiltIds = new Set(prebuiltResults.map(r => r.tool_use_id));
  const toolCallsToExecute = toolCalls.filter(tc => !prebuiltIds.has(tc.id));
  // abort 期不剥 signal / 工具自治响应 / 已 abort-aware 工具 throw / 不 aware 工具忽略
  const toolResults = await executeToolCalls(toolCallsToExecute, executor, ctx, registry, trackingCallbacks, input.auditWriter);

  if (ctx.signal?.aborted) throwAbortError(ctx.signal);
  appendToolResults(messages, [...prebuiltResults, ...toolResults]);
  // phase 1857 Step F (SE-D6): [B:safe]
  safeCallback('onMessageAppended', () => callbacks?.onMessageAppended?.('user', toolResults.length + prebuiltResults.length), callbacks, input.auditWriter);

  const totalToolCallCount = toolCallsToExecute.length + prebuiltResults.length;
  const totalParseErrorCount = prebuiltResults.length + newParseErrorCount;

  // Extract tool names from stream-layer parse-error results for error messages
  const toolNames = prebuiltResults
    .map(pr => {
      return parseToolInputErrorName(pr.content) ?? '';
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
  maxTokens: number | undefined,
): StepResult {
  const { messages } = input;
  const toolCalls = extractToolCalls(response.content);
  const prebuiltResults = response.content.filter(
    (b): b is ToolResultBlock => b.type === 'tool_result'
  );

  // State A: new tool_use in this round → synthesize [TRUNCATED] result for these new ids (pair valid)
  if (toolCalls.length > 0) {
    const assistantBlocks = response.content.filter(b => b.type !== 'tool_result' && b.type !== 'thinking');
    // Guard: skip append if assistantBlocks is empty (prevent content: [])
    if (assistantBlocks.length > 0) {
      appendAssistantMessage(messages, assistantBlocks);
      // phase 1857 Step F (SE-D6): [B:safe]
      safeCallback('onMessageAppended', () => input.callbacks?.onMessageAppended?.('assistant', assistantBlocks.length), input.callbacks, input.auditWriter);
    } else {
      // phase 1857 Step F (SE-D6): [B:safe]
      safeCallback('onMaxTokensAssistantEmptySkipped', () => input.callbacks?.onMaxTokensAssistantEmptySkipped?.({ llm: llmInfo }), input.callbacks, input.auditWriter);
      input.auditWriter?.write(
        STEP_EXECUTOR_AUDIT_EVENTS.MAX_TOKENS_ASSISTANT_EMPTY_SKIPPED,
        `model=${llmInfo.model}`,
      );
    }
    // phase 1282: prebuilt 已 cover 的 tool_use id 不再 synthesize [TRUNCATED] / 防 duplicate tool_result 同 id
    // 仅透传 stream-side parseError 结果（M#9「不丢弃静默」），historical/orphan tool_result 仍丢弃
    const parseErrorPrebuilt = prebuiltResults.filter(pr =>
      isToolInputParseError(pr.content)
    );
    const prebuiltIds = new Set(parseErrorPrebuilt.map(r => r.tool_use_id));
    const newToolCallIds = toolCalls.map(tc => tc.id).filter(id => !prebuiltIds.has(id));

    // phase 1383: detect orphan prebuilt (非 parseError + tool_use_id 不在当前 toolCalls)
    // 该路径 prebuilt 仍 drop (messages[] schema pair invariant ratify 锚不破) / 补 audit observability
    const toolCallIdSet = new Set(toolCalls.map(tc => tc.id));
    const orphanPrebuilt = prebuiltResults.filter(pr =>
      !isToolInputParseError(pr.content) &&
      !toolCallIdSet.has(pr.tool_use_id)
    );
    if (orphanPrebuilt.length > 0) {
      // phase 1857 Step F (SE-D6): [B:safe]
      safeCallback('onMaxTokensStateAOrphanDrop', () => input.callbacks?.onMaxTokensStateAOrphanDrop!({
        orphans: orphanPrebuilt.map(pr => ({
          tool_use_id: pr.tool_use_id,
          // phase 215/218: producer 传全文、消费侧 (runtime audit emit) 末端 .preview 截、字段重命名为 content
          content: pr.content,
          is_error: pr.is_error === true,
        })),
        llm: llmInfo,
      }), input.callbacks, input.auditWriter);
      for (const orphan of orphanPrebuilt) {
        input.auditWriter?.write(
          STEP_EXECUTOR_AUDIT_EVENTS.MAX_TOKENS_STATE_A_ORPHAN_DROP,
          `tool_use_id=${orphan.tool_use_id}`,
          `is_error=${orphan.is_error === true}`,
          `content_preview=${input.auditWriter?.preview(orphan.content) ?? orphan.content}`,
          `model=${llmInfo.model}`,
        );
      }
    }

    const truncatedResults: ToolResultBlock[] = newToolCallIds.map(id => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      content: maxTokens !== undefined
        ? `[TRUNCATED] 输出超过单次 token 上限（${maxTokens} tokens），工具调用被截断未执行。请将内容拆分为多次较小的调用。`
        : `[TRUNCATED] 输出达到模型 token 上限，工具调用被截断未执行。请将内容拆分为多次较小的调用。`,
      is_error: true,
    }));
    appendToolResults(messages, [...parseErrorPrebuilt, ...truncatedResults]);
    input.callbacks?.onMessageAppended?.('user', parseErrorPrebuilt.length + truncatedResults.length);
    return {
      kind: 'max_tokens_tool_use',
      meta: {
        toolCallCount: toolCalls.length,
        // parseErrorCount=0 by design: max_tokens_tool_use path does not do parse error counting
        parseErrorCount: 0,
        allParseErrors: false,
        llm: llmInfo,
      },
    };
  }

  // State B: only prebuiltResults, no new tool_use, no text → LLM added nothing this round
  //        Original code synthesized orphan tool_result + empty content [] → violates DP「no silent drop」
  //        Correct: final wrap-up with warning text
  if (prebuiltResults.length > 0) {
    // phase 1857 Step F (SE-D6): [B:safe]
    safeCallback('onMaxTokensPrebuiltOnlyFinal', () => input.callbacks?.onMaxTokensPrebuiltOnlyFinal?.({
      prebuiltCount: prebuiltResults.length,
      llm: llmInfo,
    }), input.callbacks, input.auditWriter);
    input.auditWriter?.write(
      STEP_EXECUTOR_AUDIT_EVENTS.MAX_TOKENS_PREBUILT_ONLY_FINAL,
      `prebuilt_count=${prebuiltResults.length}`,
      `model=${llmInfo.model}`,
    );
    return {
      kind: 'final',
      stopReason: asFinalStopReason('max_tokens_text'),
      finalText: maxTokens !== undefined
        ? `[Response truncated due to length limit at ${maxTokens} tokens; only stale tool_result blocks received, no new content]`
        : `[Response truncated due to model length limit; only stale tool_result blocks received, no new content]`,
    };
  }

  // State C: toolCalls=0 prebuilt=0 → text final (preserve original logic)
  const text = extractText(response.content);
  const assistantBlocks = response.content.filter(b => b.type !== 'tool_result' && b.type !== 'thinking');
  if (assistantBlocks.length > 0) {
    appendAssistantMessage(messages, response.content);
  } else {
    // phase 1857 Step F (SE-D6): [B:safe]
    safeCallback('onMaxTokensAssistantEmptySkipped', () => input.callbacks?.onMaxTokensAssistantEmptySkipped?.({ llm: llmInfo }), input.callbacks, input.auditWriter);
  }
  return {
    kind: 'final',
    stopReason: asFinalStopReason('max_tokens_text'),
    finalText: text + '\n\n[Response truncated due to length limit]',
  };
}
