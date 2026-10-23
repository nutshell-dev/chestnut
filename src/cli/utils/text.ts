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

/**
 * 剥离 orchestrator 聚合错误的外部包装，供用户可见输出使用：
 * `[LLM_ALL_PROVIDERS_FAILED] All LLM providers failed: Qwen (<payload>)` → `<payload>`。
 * 非该形态的消息原样返回；错误对象本身的 message 不改（viewport/audit 仍可识别 code）。
 */
export function stripOrchestratorWrapper(message: string): string {
  const trimmed = message.trim();
  const prefixed = /^\[[A-Z_]+\]\s+All LLM providers failed:\s+(.*)$/s.exec(trimmed);
  if (!prefixed) return trimmed;
  const body = prefixed[1];
  const single = /^[^()]+\((.*)\)$/s.exec(body);
  return single ? single[1] : body;
}
