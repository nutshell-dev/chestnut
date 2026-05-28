/**
 * Custom Anthropic SSE stream parser — pure function
 * 抽自 custom-anthropic.ts (phase 642 / mirror phase 630 / 形态 A.3 functional)
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
 * Parse Anthropic SSE event stream（含 content_block_start / tool_use / text_delta / 等 anthropic event union）
 *
 * @param providerName - provider name (用于 LLMError + LLMRateLimitError throw + observability event)
 * @param onStreamParseError - 可选 SSE parse 错回调
 */
export async function* parseAnthropicSSEStream(
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
  let currentToolId = '';
  let currentToolName = '';

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
        if (!data || data === '[DONE]') continue;

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

        if (event.type === 'content_block_start') {
          const block = event.content_block as Record<string, unknown>;
          if (block.type === 'tool_use') {
            const id = block.id as string | undefined;
            const name = block.name as string | undefined;
            if (!id || !name) {
              // tool_use 缺 id 或 name = upstream malformed / 不发 malformed yield / 走观测通道
              onStreamParseError?.({
                provider: providerName,
                raw: JSON.stringify(block).slice(0, AUDIT_MESSAGE_MAX_CHARS),
                error: 'tool_use missing id or name',
              });
              continue;
            }
            currentToolId = id;
            currentToolName = name;
            yield {
              type: 'tool_use_start',
              toolUse: {
                id: currentToolId,
                name: currentToolName,
                partialInput: '',
              },
            };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>;
          if (delta.type === 'text_delta') {
            yield { type: 'text_delta', delta: delta.text as string };
          } else if (delta.type === 'thinking_delta') {
            yield { type: 'thinking_delta', delta: delta.thinking as string };
          } else if (delta.type === 'signature_delta') {
            yield { type: 'thinking_signature', signature: delta.signature as string };
          } else if (delta.type === 'input_json_delta') {
            yield {
              type: 'tool_use_delta',
              toolUse: { id: currentToolId, name: currentToolName, partialInput: delta.partial_json as string },
            };
          }
        } else if (event.type === 'message_delta') {
          const usage = event.usage as Record<string, number> | undefined;
          const delta = event.delta as Record<string, unknown> | undefined;
          yield {
            type: 'done',
            usage: usage ? {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
            } : undefined,
            stopReason: delta?.stop_reason as string | undefined,
          };
        } else if (event.type === 'error') {
          const errorObj = event.error as Record<string, unknown> | undefined;
          const errorType = errorObj?.type as string ?? 'unknown_error';
          const errorMsg = errorObj?.message as string ?? JSON.stringify(event);
          if (errorType === 'overloaded_error') {
            throw new LLMRateLimitError(providerName);
          }
          throw new LLMError(
            `${errorType}: ${errorMsg}`,
            { provider: providerName }
          );
        }
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
