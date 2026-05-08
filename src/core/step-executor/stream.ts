/**
 * @module L3.StepExecutor.Stream
 * LLM stream collection — StreamState + stream functions
 */

import type { ContentBlock } from '../../types/message.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { LLMCallOptions } from '../../foundation/llm-orchestrator/types.js';
import type { LLMResponse } from '../../types/message.js';
import type { StepCallbacks } from './types.js';
import { safeCallback, parseToolInput } from './utils.js';
import { throwAbortError } from './abort-helpers.js';

export interface StreamState {
  contentBlocks: ContentBlock[];
  currentText: string;
  currentThinking: string;
  currentSignature: string;
  currentToolUse: { id: string; name: string; input: string } | null;
  stopReason: string;
  usage: { input_tokens: number; output_tokens: number } | undefined;
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
  };
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
    callbacks?.onTextEnd?.();
  }
}

export function flushToolUse(state: StreamState): void {
  if (state.currentToolUse) {
    state.contentBlocks.push({
      type: 'tool_use',
      id: state.currentToolUse.id,
      name: state.currentToolUse.name,
      input: parseToolInput(state.currentToolUse.input, state.currentToolUse.name),
    });
  }
}

export function resetState(state: StreamState): void {
  state.contentBlocks.length = 0;
  state.currentText = '';
  state.currentThinking = '';
  state.currentSignature = '';
  state.currentToolUse = null;
  state.stopReason = 'end_turn';
  state.usage = undefined;
}

export function finalizeContent(state: StreamState, callbacks?: StepCallbacks): void {
  if (state.currentThinking) {
    state.contentBlocks.push({
      type: 'thinking',
      thinking: state.currentThinking,
      signature: state.currentSignature,
    });
  }
  if (state.currentText) {
    state.contentBlocks.push({ type: 'text', text: state.currentText });
    callbacks?.onTextEnd?.();
  }
  if (state.currentToolUse) {
    state.contentBlocks.push({
      type: 'tool_use',
      id: state.currentToolUse.id,
      name: state.currentToolUse.name,
      input: parseToolInput(state.currentToolUse.input, state.currentToolUse.name),
    } as ContentBlock);
    state.currentToolUse = null;
  }
}

export async function collectStreamResponse(
  llm: LLMOrchestrator,
  callOptions: LLMCallOptions,
  callbacks?: StepCallbacks,
): Promise<LLMResponse> {
  const state = createStreamState();

  try {
    for await (const chunk of llm.stream(callOptions)) {
      if (callOptions.signal?.aborted) throwAbortError(callOptions.signal);
      switch (chunk.type) {
        case 'text_delta':
          flushThinking(state);
          if (chunk.delta) {
            state.currentText += chunk.delta;
            callbacks?.onTextDelta?.(chunk.delta);
          }
          break;
        case 'thinking_delta':
          if (chunk.delta) {
            state.currentThinking += chunk.delta;
            callbacks?.onThinkingDelta?.(chunk.delta);
          }
          break;
        case 'thinking_signature':
          if (chunk.signature) state.currentSignature = chunk.signature;
          break;
        case 'tool_use_start':
          flushThinking(state);
          flushText(state, callbacks);
          flushToolUse(state);
          state.currentToolUse = { id: chunk.toolUse!.id, name: chunk.toolUse!.name, input: '' };
          state.stopReason = 'tool_use';
          // 流式 tool_use_start 来时立即 emit onToolCall（chat-viewport 实时显示 tool icon / 不等 stream end + execute phase）
          // 语义改：onToolCall = LLM 已识别 tool / 不是 execute 之前 / tool-execution.ts 不再重复调
          // 用 safeCallback 守护：callback throw 不中断 stream loop（保 stream chunk 完整收 / tool_use_delta 等不丢）
          {
            const toolUseStart = chunk.toolUse!;
            safeCallback('onToolCall', () => callbacks?.onToolCall?.(toolUseStart.name, toolUseStart.id));
          }
          break;
        case 'tool_use_delta':
          if (state.currentToolUse && chunk.toolUse?.partialInput) {
            state.currentToolUse.input += chunk.toolUse.partialInput;
          }
          break;
        case 'reset':
          if (!callbacks?.onReset) console.warn(`[llm] mid-stream failover: ${chunk.provider} timed out after ${chunk.timeoutMs}ms`);
          resetState(state);
          callbacks?.onReset?.(chunk.provider ?? 'unknown', chunk.timeoutMs ?? 0);
          break;
        case 'provider_failed':
          callbacks?.onProviderFailed?.(chunk.provider ?? 'unknown', chunk.model ?? 'unknown', chunk.error ?? 'unknown error');
          break;
        case 'done':
          if (chunk.usage) {
            state.usage = { input_tokens: chunk.usage.inputTokens, output_tokens: chunk.usage.outputTokens };
          }
          if (chunk.stopReason && chunk.stopReason !== 'end_turn') state.stopReason = chunk.stopReason;
          break;
      }
    }
  } catch (err) {
    if (callOptions.signal?.aborted) {
      // 一致语义：abort 期所有 stopReason 立即抛 / partial tool_use input 丢弃
      // D1c 中断可恢复 = 下 turn LLM 重新生成完整 tool_use
      throwAbortError(callOptions.signal);
    }
    throw err;
  }

  finalizeContent(state, callbacks);

  return {
    content: state.contentBlocks,
    stop_reason: state.stopReason,
    usage: state.usage,
  };
}
