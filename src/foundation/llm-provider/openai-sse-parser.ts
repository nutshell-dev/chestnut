/**
 * OpenAI SSE stream parser — async generator
 * 抽自 openai.ts (phase 630 / 形态 A.3 functional + class-bound observability)
 * dep: providerName + onStreamParseError? callback
 */

import type { StreamChunk } from './types.js';
import type { CombinedAbortHandle } from './abort-helper.js';
import { LLMError, LLMRateLimitError } from './errors.js';
import { AUDIT_MESSAGE_MAX_CHARS } from '../audit/index.js';
import { AUDIT_PREVIEW_LEN } from '../constants.js';

export type StreamParseErrorCallback = (event: {
  provider: string;
  raw: string;
  error: string;
}) => void;

/**
 * Parse OpenAI SSE stream
 *
 * @param providerName - provider name (用于 LLMError + LLMRateLimitError throw + observability event)
 * @param onStreamParseError - 可选 SSE parse 错回调
 */
export async function* parseSSEStream(
  response: Response,
  handle: CombinedAbortHandle,
  idleTimeoutMs: number,
  providerName: string,
  onStreamParseError?: StreamParseErrorCallback,
): AsyncIterableIterator<StreamChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let idleTimer = setTimeout(() => handle.abort(), idleTimeoutMs);

  // Track tool calls across chunks (index -> partial data)
  const toolCallBuffers = new Map<
    number,
    { id: string; name: string; arguments: string; started: boolean }
  >();

  // Track finish_reason and usage for final done chunk
  let lastFinishReason: string | undefined;
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      clearTimeout(idleTimer);
      if (done) break;
      idleTimer = setTimeout(() => handle.abort(), idleTimeoutMs);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') {
          if (data === '[DONE]') {
            const stopReason =
              lastFinishReason === 'tool_calls'
                ? 'tool_use'
                : lastFinishReason === 'length'
                  ? 'max_tokens'
                  : lastFinishReason === 'stop'
                    ? 'end_turn'
                    : (lastFinishReason ?? 'end_turn');
            yield {
              type: 'done',
              stopReason,
              usage: lastUsage
                ? {
                    inputTokens: lastUsage.prompt_tokens ?? 0,
                    outputTokens: lastUsage.completion_tokens ?? 0,
                  }
                : undefined,
            };
          }
          continue;
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data);
        } catch (err) {
          onStreamParseError?.({
            provider: providerName,
            raw: data.slice(0, AUDIT_PREVIEW_LEN),
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        // SSE-level error event (no choices, top-level error object)
        const sseError = event.error as Record<string, unknown> | undefined;
        if (sseError && !event.choices) {
          const errorType = (sseError.type as string) ?? 'unknown_error';
          const errorMsg = (sseError.message as string) ?? JSON.stringify(event);
          const errorCode = sseError.code as string | undefined;
          if (errorCode === '429' || errorType === 'rate_limit_error') {
            throw new LLMRateLimitError(providerName);
          }
          throw new LLMError(`${errorType}: ${errorMsg}`, { provider: providerName });
        }

        // Track finish_reason and usage from event
        const choice = (event.choices as Array<Record<string, unknown>>)?.[0];
        const finishReason = choice?.finish_reason as string | undefined;
        if (finishReason) lastFinishReason = finishReason;

        const usage = event.usage as
          | { prompt_tokens?: number; completion_tokens?: number }
          | undefined;
        if (usage?.prompt_tokens !== undefined) lastUsage = usage;

        const delta = choice?.delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          yield { type: 'text_delta', delta: String(delta.content) };
        }

        // DeepSeek Reasoner thinking
        if (delta.reasoning_content) {
          yield { type: 'thinking_delta', delta: String(delta.reasoning_content) };
        }

        // OpenAI o-series reasoning (delta.reasoning)
        if (delta.reasoning) {
          yield { type: 'thinking_delta', delta: String(delta.reasoning) };
        }

        // Tool calls
        const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            const index = tc.index as number;
            const func = tc.function as Record<string, unknown> | undefined;

            if (!toolCallBuffers.has(index)) {
              // New tool call
              toolCallBuffers.set(index, {
                id: (tc.id as string) || '',
                name: (func?.name as string) || '',
                arguments: (func?.arguments as string) || '',
                started: false,
              });
            } else {
              // Existing tool call - accumulate arguments
              const buf = toolCallBuffers.get(index)!;
              if (tc.id) buf.id = tc.id as string;
              if (func?.name) buf.name = func.name as string;
              if (func?.arguments) buf.arguments += func.arguments as string;
            }

            const buf = toolCallBuffers.get(index)!;

            // Emit tool_use_start only when both id and name are available
            if (!buf.started && buf.id && buf.name) {
              buf.started = true;
              yield {
                type: 'tool_use_start',
                toolUse: { id: buf.id, name: buf.name, partialInput: '' },
              };
            }

            // Emit tool_use_delta for accumulated arguments
            if (func?.arguments && buf.started) {
              yield {
                type: 'tool_use_delta',
                toolUse: { id: buf.id, name: buf.name, partialInput: func.arguments as string },
              };
            }
          }
        }
      }
    }
    // Stream-end check: 任 buffer 未 emit 但部分 id/name 存在 → upstream malformed tool_call
    for (const buf of toolCallBuffers.values()) {
      if (!buf.started && (buf.id !== '' || buf.name !== '')) {
        onStreamParseError?.({
          provider: providerName,
          raw: JSON.stringify({ id: buf.id, name: buf.name }).slice(0, AUDIT_MESSAGE_MAX_CHARS),
          error: 'tool_use buffer incomplete (missing id or name at stream end)',
        });
      }
    }
  } finally {
    clearTimeout(idleTimer);
    try {
      // phase 1022 r124 H fork: cancel underlying body stream (cancel implies release per WHATWG Streams spec)
      // 释放 TCP buffered chunk + reader lock 单 API、abort 后不再 hold 1-10MB memory + token 浪费
      await reader.cancel();
    } catch {
      // silent: stream already done/cancelled/released; no-op per WHATWG spec
    }
  }
}
