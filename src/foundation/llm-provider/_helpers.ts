/**
 * Parse HTTP `Retry-After` header value to integer.
 *
 * Per HTTP spec the value is in **seconds** (or HTTP-date — only delta-seconds
 * supported here). Returns the raw integer or undefined if the header is
 * absent / empty. Does not normalize NaN — callers preserve existing behavior
 * (NaN propagates to LLMRateLimitError.retryAfter as-is).
 *
 * Used by 4 LLM provider adapters (anthropic / custom-anthropic / gemini / openai).
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
): number | undefined {
  return headerValue ? parseInt(headerValue, 10) : undefined;
}
