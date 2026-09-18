/**
 * @module L3.StepExecutor.LLMStreamCollector
 * LLM provider stream collection — StreamState + collect/flush helpers.
 * phase 1407: renamed from `stream.ts` to disambiguate from L2 `foundation/stream/` event-log module.
 */

import type { ContentBlock } from '../../foundation/llm-provider/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { LLMCallOptions } from '../../foundation/llm-orchestrator/index.js';
import type { LLMResponse } from '../../foundation/llm-provider/index.js';
import type { StepExecutorEventSink } from './audit-sink.js';
import type { StepCallbacks } from './types.js';
import { safeCallback, parseToolInput } from './utils.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { throwAbortError } from './abort-helpers.js';
import { makeToolUseId, LLMTimeoutError } from '../../foundation/llm-provider/index.js';
import { LLMAllProvidersFailedError } from '../../foundation/llm-orchestrator/index.js';
import { formatToolInputParseError } from './tool-input-parse-error.js';


export interface StreamState {
  contentBlocks: ContentBlock[];
  currentText: string;
  currentThinking: string;
  currentSignature: string;
  currentToolUse: { id: string; name: string; input: string } | null;
  stopReason: string;
  usage: { input_tokens: number; output_tokens: number } | undefined;
  /** phase 688: 首 chunk 到达时设置、catch 路径 emit discarded 时作 ts_range 起点 */
  startTs: number;
}

export function createStreamState(): StreamState {
  return {
    contentBlocks: [],
    currentText: '',
    currentThinking: '',
    currentSignature: '',
    currentToolUse: null,
    stopReason: 'end_turn',
    usage: undefined,
    startTs: 0,
  };
}

/** phase 688: 按 catch err 分类丢弃原因（与 collector catch 触发场景对齐） */
function classifyDiscardCause(err: unknown): 'all_providers_failed' | 'idle_timeout' | 'unknown' {
  if (err instanceof LLMAllProvidersFailedError) return 'all_providers_failed';
  if (err instanceof LLMTimeoutError) return 'idle_timeout';
  return 'unknown';
}

export function flushThinking(state: StreamState): void {
  if (state.currentThinking) {
    state.contentBlocks.push({
      type: 'thinking',
      thinking: state.currentThinking,
      signature: state.currentSignature,
    });
    state.currentThinking = '';
    state.currentSignature = '';
  }
}

export function flushText(state: StreamState, callbacks?: StepCallbacks): void {
  if (state.currentText) {
    state.contentBlocks.push({ type: 'text', text: state.currentText });
    state.currentText = '';
    // phase 1857 Step F (SE-D6): [B:safe] 失败经 onSafeCallbackError 留证，不终止 step
    safeCallback('onTextEnd', () => callbacks?.onTextEnd?.(), callbacks);
  }
}

export function flushToolUse(state: StreamState, callbacks?: StepCallbacks, eventSink?: StepExecutorEventSink): void {
  if (state.currentToolUse) {
    const toolName = state.currentToolUse.name;
    const toolUseId = makeToolUseId(state.currentToolUse.id);
    const rawInput = state.currentToolUse.input;
    const parsed = parseToolInput(rawInput, toolName);
    if (!parsed.ok) {
      // phase 1857 Step I (SE-D9): 裁决事实经单一事件出口一次发出（展示+持久化归 caller adapter）
      eventSink?.toolInputParseFailed({
        toolName,
        toolUseId,
        reason: 'parse_error',
        summary: rawInput,
      });
      // phase 1282: emit tool_use 占位块满足 pair invariant（M#9 + M#5 stream 自验合法）
      //            input={} 占位 / 下游 handleToolUseStop + handleMaxTokensStop State A 经 prebuiltIds dedup 不 execute / 不再 synthesize
      state.contentBlocks.push({
        type: 'tool_use',
        id: makeToolUseId(state.currentToolUse.id),
        name: state.currentToolUse.name,
        input: {},
      });
      state.contentBlocks.push({
        type: 'tool_result',
        tool_use_id: state.currentToolUse.id,
        content: formatToolInputParseError(state.currentToolUse.name, parsed.raw),
        is_error: true,
      });
    } else {
      const toolId = state.currentToolUse.id;
      const toolName = state.currentToolUse.name;
      const inputData = parsed.data;
      state.contentBlocks.push({
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input: inputData,
      });
      // phase 688: API 收到的 args body 必落 stream.jsonl，不依赖 finalizeContent 被 catch 路径跳过
      safeCallback(
        'onToolUseInput',
        () => callbacks?.onToolUseInput?.(toolName, makeToolUseId(toolId), inputData),
        callbacks,
        eventSink,
      );
    }
    // phase 688: 与 finalizeContent 对齐，flush 后清 currentToolUse 防 catch 路径 drain 时重复 emit
    state.currentToolUse = null;
  }
}

function resetState(state: StreamState): void {
  state.contentBlocks.length = 0;
  state.currentText = '';
  state.currentThinking = '';
  state.currentSignature = '';
  state.currentToolUse = null;
  state.stopReason = 'end_turn';
  state.usage = undefined;
  state.startTs = 0;
}

export function finalizeContent(state: StreamState, callbacks?: StepCallbacks, eventSink?: StepExecutorEventSink): void {
  if (state.currentThinking) {
    state.contentBlocks.push({
      type: 'thinking',
      thinking: state.currentThinking,
      signature: state.currentSignature,
    });
  }
  if (state.currentText) {
    state.contentBlocks.push({ type: 'text', text: state.currentText });
    // phase 1857 Step F (SE-D6): [B:safe]
    safeCallback('onTextEnd', () => callbacks?.onTextEnd?.(), callbacks, eventSink);
  }
  if (state.currentToolUse) {
    const toolName = state.currentToolUse.name;
    const toolUseId = makeToolUseId(state.currentToolUse.id);
    const rawInput = state.currentToolUse.input;
    const parsed = parseToolInput(rawInput, toolName);
    if (!parsed.ok) {
      // phase 1857 Step I (SE-D9): 单一事件出口
      eventSink?.toolInputParseFailed({
        toolName,
        toolUseId,
        reason: 'parse_error',
        summary: rawInput,
      });
      // phase 1282: emit tool_use 占位块满足 pair invariant（M#9 + M#5 stream 自验合法）
      state.contentBlocks.push({
        type: 'tool_use',
        id: toolUseId,
        name: toolName,
        input: {},
      } as ContentBlock);
      state.contentBlocks.push({
        type: 'tool_result',
        tool_use_id: state.currentToolUse.id,
        content: formatToolInputParseError(toolName, parsed.raw),
        is_error: true,
      } as ContentBlock);
    } else {
      const toolId = state.currentToolUse.id;
      const toolName = state.currentToolUse.name;
      const inputData = parsed.data;
      state.contentBlocks.push({
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input: inputData,
      } as ContentBlock);
      // phase 688: finalize 路径同 flushToolUse、对外契约一致
      safeCallback(
        'onToolUseInput',
        () => callbacks?.onToolUseInput?.(toolName, makeToolUseId(toolId), inputData),
        callbacks,
        eventSink,
      );
    }
    state.currentToolUse = null;
  }
}

export async function collectStreamResponse(
  llm: LLMOrchestrator,
  callOptions: LLMCallOptions,
  callbacks?: StepCallbacks,
  eventSink?: StepExecutorEventSink,
): Promise<LLMResponse> {
  const state = createStreamState();

  try {
    for await (const chunk of llm.stream(callOptions)) {
      if (callOptions.signal?.aborted) throwAbortError(callOptions.signal);
      // phase 688: 首 chunk 到达时 stamp startTs（catch 路径 emit discarded 时作 ts_range 起点）
      if (state.startTs === 0) state.startTs = Date.now();
      switch (chunk.type) {
        case 'text_delta':
          flushThinking(state);
          if (chunk.delta) {
            const delta = chunk.delta;
            state.currentText += delta;
            // phase 1857 Step F (SE-D6): [B:safe]
            safeCallback('onTextDelta', () => callbacks?.onTextDelta?.(delta), callbacks, eventSink);
          }
          break;
        case 'thinking_delta':
          if (chunk.delta) {
            const delta = chunk.delta;
            state.currentThinking += delta;
            // phase 1857 Step F (SE-D6): [B:safe]
            safeCallback('onThinkingDelta', () => callbacks?.onThinkingDelta?.(delta), callbacks, eventSink);
          }
          break;
        case 'thinking_signature':
          if (chunk.signature) state.currentSignature = chunk.signature;
          break;
        case 'tool_use_start':
          flushThinking(state);
          flushText(state, callbacks);
          flushToolUse(state, callbacks, eventSink);
          state.currentToolUse = { id: chunk.toolUse!.id, name: chunk.toolUse!.name, input: '' };
          state.stopReason = 'tool_use';
          // 流式 tool_use_start 来时立即 emit onToolCall（chat-viewport 实时显示 tool icon / 不等 stream end + execute phase）
          // 语义改：onToolCall = LLM 已识别 tool / 不是 execute 之前 / tool-execution.ts 不再重复调
          // 用 safeCallback 守护：callback throw 不中断 stream loop（保 stream chunk 完整收 / tool_use_delta 等不丢）
          {
            const toolUseStart = chunk.toolUse!;
            safeCallback('onToolCall', () => callbacks?.onToolCall?.(toolUseStart.name, makeToolUseId(toolUseStart.id)), callbacks, eventSink);
          }
          break;
        case 'tool_use_delta':
          if (state.currentToolUse && chunk.toolUse?.partialInput) {
            state.currentToolUse.input += chunk.toolUse.partialInput;
            // phase 1180: forward raw partial input for streaming content extraction
            // phase 1857 Step F (SE-D6): [B:safe]
            safeCallback(
              'onToolUseInputDelta',
              () => callbacks?.onToolUseInputDelta?.(
                state.currentToolUse!.name,
                makeToolUseId(state.currentToolUse!.id),
                chunk.toolUse!.partialInput!,
              ),
              callbacks,
              eventSink,
            );
          }
          break;
        case 'reset':
          resetState(state);
          // phase 1857 Step F (SE-D6): [B:safe] reset 已发生，通知失败不改变已发生提交
          safeCallback('onReset', () => callbacks?.onReset?.(chunk.provider ?? 'unknown', chunk.timeoutMs ?? 0), callbacks, eventSink);
          break;
        case 'provider_failed':
          // phase 1857 Step F (SE-D6): [B:safe] provider 失败已发生，通知失败不改变已记录失败
          safeCallback(
            'onProviderFailed',
            () => callbacks?.onProviderFailed?.(chunk.provider ?? 'unknown', chunk.model ?? 'unknown', chunk.error ?? 'unknown error'),
            callbacks,
            eventSink,
          );
          break;
        case 'done':
          if (chunk.usage) {
            state.usage = { input_tokens: chunk.usage.inputTokens, output_tokens: chunk.usage.outputTokens };
          }
          if (chunk.stopReason && chunk.stopReason !== 'end_turn') state.stopReason = chunk.stopReason;
          break;
        default: {
          // phase 364 D1 (review-2026-06-13): exhaustive 守 stream chunk type literal-union。
          // phase 1722 E：chunk 现为 LLMOrchestrator `LLMStreamChunk` discriminated union
          // （ProviderStreamChunk ∪ reset/provider_failed control 成员），narrow 仍针对 chunk.type 字段。
          const _exhaustive: never = chunk;
          throw new Error(`llm-stream-collector: unhandled chunk type: ${String(_exhaustive)}`);
        }
      }
    }
  } catch (err) {
    if (callOptions.signal?.aborted) {
      // 一致语义：abort 期所有 stopReason 立即抛 / partial tool_use input 丢弃
      // D1c 中断可恢复 = 下 turn LLM 重新生成完整 tool_use
      throwAbortError(callOptions.signal);
    }
    // phase 688: rethrow 前 drain in-flight state，让已收到但未 flush 的 args body 落 stream.jsonl
    // best-effort：drain 自身抛错不污染原 err（safeCallback 已守 callback throw）
    // 此处 contentBlocks 仍随作用域 GC（dialog 不持久 partial assistant message、不破 pair invariant）
    // 但 stream.jsonl 已记录每个 tool_use 的完整 input、事后凭 trace_id 可重建调用意图
    try { flushThinking(state); } catch { /* silent: drain best-effort, rethrow below preserves original error */ }
    try { flushText(state, callbacks); } catch { /* silent: drain best-effort, rethrow below preserves original error */ }
    try { flushToolUse(state, callbacks, eventSink); } catch { /* silent: drain best-effort, rethrow below preserves original error */ }
    // phase 688: emit「丢弃 partial assistant content」决策事件（audit 可观测）
    // 决策动作本身的可观测点、与 stream.jsonl 的 tool_use_input 互补。
    if (state.startTs > 0) {
      const toolUseCount = state.contentBlocks.filter(b => b.type === 'tool_use').length;
      const hasText = state.contentBlocks.some(b => b.type === 'text');
      const hasThinking = state.contentBlocks.some(b => b.type === 'thinking');
      // phase 1857 Step I (SE-D9): 裁决事实经单一事件出口一次发出；
      // SE-D4 语义由实现契约承接（sink 不抛——审计失败不改变随后原样抛出的原 err）。
      eventSink?.partialAssistantDiscarded({
        cause: classifyDiscardCause(err),
        toolUseCount,
        hasText,
        hasThinking,
        tsRange: `${state.startTs}-${Date.now()}`,
        errMessage: formatErr(err),
      });
    }
    throw err;
  }

  finalizeContent(state, callbacks, eventSink);

  return {
    content: state.contentBlocks,
    stop_reason: state.stopReason,
    usage: state.usage,
  };
}
