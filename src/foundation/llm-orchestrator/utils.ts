/**
 * @module L2b.LLMOrchestrator.Utils
 * Pure utility functions extracted from orchestrator.ts
 *
 * 抽出动机：orchestrator.ts SRP 治理（llmorchestrator-auditor §4.1 follow-up）。
 * 函数无 this 依赖、纯逻辑、易测试。
 */

import type { LLMResponse, TextBlock, ThinkingBlock, ToolUseBlock } from '../llm-provider/types.js';
import { makeExternalAbortError, type AbortReason } from '../llm-provider/abort-helper.js';
import type { StreamChunk } from '../llm-provider/types.js';

/**
 * AbortSignal-aware delay.
 * Used by call()/stream() retry backoff to respect external abort promptly
 * (without this, abort during backoff would wait up to 30s before responding).
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeExternalAbortError(signal?.reason as AbortReason | undefined));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeExternalAbortError(signal?.reason as AbortReason | undefined));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Whether a stream chunk carries content (text/thinking/tool_use). */
export function isContentChunk(chunk: StreamChunk): boolean {
  return chunk.type === 'text_delta'
    || chunk.type === 'thinking_delta'
    || chunk.type === 'tool_use_start'
    || chunk.type === 'tool_use_delta';
}

/** Wrap a non-streaming LLMResponse as a stream of chunks. */
export async function* wrapResponseAsStream(
  response: LLMResponse,
): AsyncIterableIterator<StreamChunk> {
  for (const block of response.content) {
    if (block.type === 'text') {
      const b = block as TextBlock;
      yield { type: 'text_delta', delta: b.text };
    } else if (block.type === 'thinking') {
      const b = block as ThinkingBlock;
      yield { type: 'thinking_delta', delta: b.thinking };
      if (b.signature) yield { type: 'thinking_signature', signature: b.signature };
    } else if (block.type === 'tool_use') {
      const b = block as ToolUseBlock;
      yield { type: 'tool_use_start', toolUse: { id: b.id, name: b.name } };
      yield {
        type: 'tool_use_delta',
        toolUse: { id: b.id, name: b.name, partialInput: JSON.stringify(b.input) },
      };
    }
    // ignore tool_result / unknown blocks (assistant response shouldn't have these)
  }
  yield {
    type: 'done',
    stopReason: typeof response.stop_reason === 'string' ? response.stop_reason : 'end_turn',
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? undefined,
          cacheReadInputTokens: response.usage.cache_read_input_tokens ?? undefined,
        }
      : undefined,
  };
}

/** Merge two abort signals into one. Returns a combined signal and a cleanup function. */
export function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!a && !b) return { signal: undefined, cleanup: () => {} };
  if (!a) return { signal: b, cleanup: () => {} };
  if (!b) return { signal: a, cleanup: () => {} };
  const ctrl = new AbortController();
  if (a.aborted || b.aborted) {
    ctrl.abort();
    return { signal: ctrl.signal, cleanup: () => {} };
  }
  const abort = () => ctrl.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return {
    signal: ctrl.signal,
    cleanup: () => {
      a.removeEventListener('abort', abort);
      b.removeEventListener('abort', abort);
    },
  };
}
