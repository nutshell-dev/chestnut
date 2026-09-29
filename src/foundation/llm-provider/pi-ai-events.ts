/**
 * @module L1.LLMProvider.PiAi
 *
 * pi-ai AssistantMessageEvent → chestnut ProviderStreamChunk 翻译（Phase 1925 Step C，
 * 设计稿 D1.2）。保持既有 chunk 语义：
 * - text_delta / thinking_delta 直译；thinking signature 在 thinking_end 时从
 *   partial.content[i].thinkingSignature 取（事件本身不携带）；
 * - toolcall_start → tool_use_start（id/name 以 partial 当时值为准，后续事件可补全）；
 * - toolcall_delta → tool_use_delta.partialInput（JSON 文本增量，拼接语义不变）；
 * - toolcall_end 交付已解析对象：若该 call 未产生过 delta（provider 一次性交付），
 *   重新字符串化 arguments 合成单条 delta（K3）；已有 delta 则不重复交付；
 * - done → done chunk（usage/stopReason 映射）；error 由 adapter 错误面处理（不在此）。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import type { ProviderStreamChunk } from './types.js';

/** 单个 tool call 的跨事件跟踪。 */
interface ToolCallTrack {
  id: string;
  name: string;
  /** 已发出的 partialInput delta 条数（0 = provider 未给增量，end 时需合成）。 */
  deltaCount: number;
}

export interface EventTranslationState {
  toolCalls: Map<number, ToolCallTrack>;
}

export function createEventTranslationState(): EventTranslationState {
  return { toolCalls: new Map() };
}

function toolCallAt(partial: PiAi.AssistantMessage, contentIndex: number): PiAi.ToolCall | undefined {
  const block = partial.content[contentIndex];
  return block && block.type === 'toolCall' ? block : undefined;
}

function thinkingAt(partial: PiAi.AssistantMessage, contentIndex: number): PiAi.ThinkingContent | undefined {
  const block = partial.content[contentIndex];
  return block && block.type === 'thinking' ? block : undefined;
}

/** pi-ai StopReason → chestnut stop_reason 词汇（end_turn/max_tokens/tool_use 保持三家归一）。 */
export function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'toolUse': return 'tool_use';
    default: return reason ?? 'end_turn';
  }
}

export function mapUsage(usage: PiAi.Usage | undefined): ProviderStreamChunk['usage'] | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheWrite > 0 && { cacheCreationInputTokens: usage.cacheWrite }),
    ...(usage.cacheRead > 0 && { cacheReadInputTokens: usage.cacheRead }),
  };
}

/**
 * 翻译单个事件为 0..n 个 chunk。调用方按序驱动；state 跨事件共享。
 * error 事件返回 undefined（由 adapter 错误面统一构造 typed error）。
 */
export function translatePiAiEvent(
  event: PiAi.AssistantMessageEvent,
  state: EventTranslationState,
): ProviderStreamChunk[] | undefined {
  switch (event.type) {
    case 'text_delta':
      return [{ type: 'text_delta', delta: event.delta }];

    case 'thinking_delta':
      return [{ type: 'thinking_delta', delta: event.delta }];

    case 'thinking_end': {
      const thinking = thinkingAt(event.partial, event.contentIndex);
      if (thinking?.thinkingSignature) {
        return [{ type: 'thinking_signature', signature: thinking.thinkingSignature }];
      }
      return [];
    }

    case 'toolcall_start': {
      const toolCall = toolCallAt(event.partial, event.contentIndex);
      const track: ToolCallTrack = {
        id: toolCall?.id ?? '',
        name: toolCall?.name ?? '',
        deltaCount: 0,
      };
      state.toolCalls.set(event.contentIndex, track);
      return [{ type: 'tool_use_start', toolUse: { id: track.id, name: track.name } }];
    }

    case 'toolcall_delta': {
      const track = state.toolCalls.get(event.contentIndex);
      const toolCall = toolCallAt(event.partial, event.contentIndex);
      if (track) {
        // id/name 可能在 start 后才补全（OpenAI 族首 chunk 才带 id）
        if (track.id === '' && toolCall?.id) track.id = toolCall.id;
        if (track.name === '' && toolCall?.name) track.name = toolCall.name;
        track.deltaCount += 1;
      }
      return [{
        type: 'tool_use_delta',
        toolUse: {
          id: track?.id ?? toolCall?.id ?? '',
          name: track?.name ?? toolCall?.name ?? '',
          partialInput: event.delta,
        },
      }];
    }

    case 'toolcall_end': {
      const track = state.toolCalls.get(event.contentIndex);
      state.toolCalls.delete(event.contentIndex);
      // 未产生过 delta → provider 一次性交付（K3：已解析对象需重新字符串化）
      if ((track?.deltaCount ?? 0) === 0) {
        return [{
          type: 'tool_use_delta',
          toolUse: {
            id: event.toolCall.id,
            name: event.toolCall.name,
            partialInput: JSON.stringify(event.toolCall.arguments),
          },
        }];
      }
      return [];
    }

    case 'done':
      return [{
        type: 'done',
        usage: mapUsage(event.message.usage),
        stopReason: mapStopReason(event.message.stopReason),
      }];

    default:
      // start / text_start / text_end / thinking_start / error 等：无 chunk 产出
      return [];
  }
}
