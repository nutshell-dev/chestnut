/**
 * @module L2b.LLMOrchestrator.Utils
 * Pure utility functions extracted from orchestrator.ts
 *
 * 抽出动机：orchestrator.ts SRP 治理（llmorchestrator-auditor §4.1 follow-up）。
 * 函数无 this 依赖、纯逻辑、易测试。
 */

import type { LLMResponse, TextBlock, ThinkingBlock, ToolUseBlock, ProviderStreamChunk } from '../llm-provider/index.js';
import {
  estimateMessagesTokens,
  estimateTextTokens,
  estimateToolsTokens,
  makeExternalAbortError,
} from '../llm-provider/index.js';
import type { LLMCallOptions } from './types.js';
import {
  LLM_CONTEXT_BUDGET_HARD_RATIO,
  LLM_CONTEXT_BUDGET_WARN_RATIO,
  LLM_TIMEOUT_MAX_MS,
  LLM_TIMEOUT_TOKENS_PER_SECOND,
} from './defaults.js';

/**
 * AbortSignal-aware delay.
 * Used by call()/stream() retry backoff to respect external abort promptly
 * (without this, abort during backoff would wait up to 30s before responding).
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeExternalAbortError(signal?.reason));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeExternalAbortError(signal?.reason));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Phase 1955 Step E：调用前输入预算估计（messages + system + tools）。 */
export function estimatePromptTokens(options: LLMCallOptions): number {
  // 防御畸形调用（测试/JS caller 可能省略 messages）：估计是旁路，不得改变原有报错面。
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const tools = Array.isArray(options.tools) ? options.tools : [];
  return estimateMessagesTokens(messages)
    + estimateTextTokens(options.system ?? '')
    + estimateToolsTokens(tools);
}

export type ContextBudgetClass = 'ok' | 'warn' | 'exceeded';

/** 预算分类：>= 80% 硬上限；>= 70% 预警。调用方保证 contextWindow > 0。 */
export function classifyContextBudget(
  estimatedTokens: number,
  contextWindow: number,
): ContextBudgetClass {
  const ratio = estimatedTokens / contextWindow;
  if (ratio >= LLM_CONTEXT_BUDGET_HARD_RATIO) return 'exceeded';
  if (ratio >= LLM_CONTEXT_BUDGET_WARN_RATIO) return 'warn';
  return 'ok';
}

/**
 * 动态调用 timeout：基础配置时间 + 按输入规模增加的生成/传输余量，封顶 10min。
 * 输入越大 → 给越长 wall-clock；持续有 chunk 的 stream 仍由 idle timeout 判定。
 */
export function computeDynamicCallTimeoutMs(
  baseTimeoutMs: number,
  estimatedTokens: number,
): number {
  const padded = baseTimeoutMs
    + Math.ceil((Math.max(0, estimatedTokens) / LLM_TIMEOUT_TOKENS_PER_SECOND) * 1000);
  return Math.min(Math.max(padded, baseTimeoutMs), LLM_TIMEOUT_MAX_MS);
}

/** Whether a stream chunk carries content (text/thinking/tool_use). */
export function isContentChunk(chunk: ProviderStreamChunk): boolean {
  return chunk.type === 'text_delta'
    || chunk.type === 'thinking_delta'
    || chunk.type === 'tool_use_start'
    || chunk.type === 'tool_use_delta';
}

/** Wrap a non-streaming LLMResponse as a stream of chunks. */
export async function* wrapResponseAsStream(
  response: LLMResponse,
): AsyncIterableIterator<ProviderStreamChunk> {
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
