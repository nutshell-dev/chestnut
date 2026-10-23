/**
 * Phase 1983 follow-up：CLI 文本截断（codepoint 安全）。
 * LLM 错误预览与 endpoint 全败摘要共用，避免两处 200 字面漂移。
 */

export const LLM_ERROR_PREVIEW_CHARS = 200;

export function truncateLLMMessage(message: string): string {
  const codepoints = [...message];
  return codepoints.length > LLM_ERROR_PREVIEW_CHARS
    ? codepoints.slice(0, LLM_ERROR_PREVIEW_CHARS).join('') + '...'
    : message;
}
