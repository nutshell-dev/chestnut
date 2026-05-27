/**
 * Gemini SSE stream parser — pure function
 * 抽自 gemini.ts (phase 642 / mirror phase 630)
 * 参数化 this.name → providerName param
 */

import type { StreamChunk } from './types.js';
import type { CombinedAbortHandle } from './abort-helper.js';
import { LLMError, LLMRateLimitError } from './errors.js';
import { AUDIT_PREVIEW_LEN } from '../constants.js';

interface GeminiResponse {
  candidates: Array<{
    content: {
      role: 'user' | 'model';
      parts: Array<
        | { text: string }
        | { functionCall: { name: string; args: Record<string, unknown> } }
      >;
    };
    finishReason: string;
  }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

export async function* parseGeminiSSEStream(
  response: Response,
  handle: CombinedAbortHandle,
  idleTimeoutMs: number,
  providerName: string,
  onStreamParseError?: (event: { provider: string; raw: string; error: string }) => void,
): AsyncIterableIterator<StreamChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let idleTimer = setTimeout(() => handle.abort(), idleTimeoutMs);
  let fcIndex = 0;
  let lastUsage: { promptTokenCount: number; candidatesTokenCount: number } | undefined;

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

        let event: GeminiResponse & { error?: { code?: number; message?: string; status?: string } };
        try { event = JSON.parse(data); } catch (e) {
          onStreamParseError?.({
            provider: providerName,
            raw: data.slice(0, AUDIT_PREVIEW_LEN),
            error: e instanceof Error ? e.message : String(e),
          });
          continue;
        }

        // SSE-level error (no candidates, top-level error object)
        if (event.error && !event.candidates) {
          const { code, message, status } = event.error;
          if (code === 429) {
            throw new LLMRateLimitError(providerName);
          }
          throw new LLMError(
            `${status ?? 'error'}: ${message ?? JSON.stringify(event.error)}`,
            { provider: providerName }
          );
        }

        const candidate = event.candidates?.[0];
        if (!candidate) continue;

        for (const part of candidate.content?.parts ?? []) {
          if ('text' in part) {
            yield { type: 'text_delta', delta: part.text };
          } else if ('functionCall' in part) {
            const { name, args } = part.functionCall;
            const id = `gemini-${name}-${fcIndex}`;
            yield { type: 'tool_use_start', toolUse: { id, name, partialInput: '' } };
            yield { type: 'tool_use_delta', toolUse: { id, name, partialInput: JSON.stringify(args) } };
            fcIndex++;
          }
        }

        // Track usage metadata across events
        if (event.usageMetadata) {
          lastUsage = event.usageMetadata;
        }

        // Yield done chunk when finishReason is available (decoupled from usageMetadata)
        if (candidate.finishReason) {
          const stopReason =
            candidate.finishReason === 'STOP'       ? 'end_turn' :
            candidate.finishReason === 'MAX_TOKENS' ? 'max_tokens' :
            candidate.finishReason === 'SAFETY'     ? 'content_filter' :
            candidate.finishReason.toLowerCase();

          yield {
            type: 'done',
            stopReason,
            usage: lastUsage ? {
              inputTokens: lastUsage.promptTokenCount,
              outputTokens: lastUsage.candidatesTokenCount,
            } : undefined,
          };
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
