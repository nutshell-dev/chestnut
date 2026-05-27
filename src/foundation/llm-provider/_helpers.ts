/**
 * HTTP 5xx server error 起点（RFC 7231 §6.6 status code range start）。
 * 用于 LLM provider response 错误分类、>= 此值视为 server-side 错误。
 */
const HTTP_SERVER_ERROR_STATUS_MIN = 500;

import { LLMError, LLMRateLimitError, LLMAuthError, LLMModelNotFoundError } from './errors.js';

/**
 * Parse HTTP error response and throw the appropriate LLMError subclass.
 *
 * Handles fetch Response with 4xx/5xx status:
 * - 429 → LLMRateLimitError with parsed retry-after header
 * - 5xx → LLMError "server error" tier
 * - else → LLMError generic
 *
 * Used by 3 fetch-based LLM provider adapters (openai / custom-anthropic / gemini)
 * to deduplicate ~22 lines × 3 site of byte-identical error handling logic.
 *
 * Message format unified: `Provider ${provider} (server )?error (${status}): ${text}`
 * (gemini's historical "Server error" / "Request failed" format aligned to standard
 * by phase 592 / 28 原则核 5/5 dominant α / M#1+M#7+D5 align).
 */
export async function throwHttpErrorResponse(
  provider: string,
  response: Response,
): Promise<never> {
  const status = response.status;
  let errorText: string;
  const cloned = response.clone();

  try {
    const errorData = await response.json() as { error?: { message?: string } };
    errorText = errorData.error?.message ?? JSON.stringify(errorData);
  } catch {
    errorText = await cloned.text();
  }

  // phase 735 step 2: 401/403/404 分类（permanent / 0 retry）
  if (status === 401 || status === 403) {
    throw new LLMAuthError(provider, status, errorText);
  }
  if (status === 404) {
    // model 名称 derive 自 errorText（如 "model 'xxx' not found"）/ fallback 'unknown'
    const modelMatch = errorText.match(/model\s+['"]?([\w.-]+)['"]?/i);
    throw new LLMModelNotFoundError(provider, modelMatch?.[1] ?? 'unknown');
  }

  if (status === 429) {
    const retryAfter = response.headers.get('retry-after');
    throw new LLMRateLimitError(provider, parseRetryAfter(retryAfter));
  }

  if (status >= HTTP_SERVER_ERROR_STATUS_MIN) {
    throw new LLMError(
      `Provider ${provider} server error (${status}): ${errorText}`,
      { provider, status },
    );
  }

  throw new LLMError(
    `Provider ${provider} error (${status}): ${errorText}`,
    { provider, status },
  );
}

/**
 * Parse HTTP `Retry-After` header value to integer.
 *
 * Per HTTP spec the value is in **seconds** (or HTTP-date — only delta-seconds
 * supported here). Returns the raw integer or undefined if the header is
 * absent / empty / non-numeric.
 *
 * **phase 592 normalize NaN to undefined**（revoke phase 563 prior behavior preservation）：
 * - phase 563 jsdoc 原文「does not normalize NaN — preserves prior behavior」
 * - 0 downstream consumer 用 `.retryAfter` field（grep verify）
 * - NaN 是 type liar (number) / D2 silent NaN propagation 是 latent bug
 * - 加 `Number.isNaN(ms) ? undefined : ms` guard 严格化返值 type 契约
 *
 * Used by 4 LLM provider adapters (anthropic / custom-anthropic / gemini / openai)
 * + throwHttpErrorResponse helper (phase 592).
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
): number | undefined {
  if (!headerValue) return undefined;
  const ms = parseInt(headerValue, 10);
  return Number.isNaN(ms) ? undefined : ms;
}
