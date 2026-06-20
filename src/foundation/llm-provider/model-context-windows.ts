/**
 * @module L1.LLMProvider.ModelContextWindows
 *
 * Model context window (token) 查表 + fallback。
 *
 * phase 440 在 step-executor 立、phase 453 runtime 第二消费 → 抽 L1 单源（M#3）。
 *
 * 注：本表是各 provider model 的 context window 字面值、不是裁剪相关业务字面；
 * 归 L1 LLMProvider（model 字面与 LLM API 协议层同源）、非 L4 ContextManager。
 */

/** 默认 context window（model 未在表内时 fallback） */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

/** Model name → context window 字面值表 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-3-7-sonnet-20250219': 200_000,
  'gpt-4o': DEFAULT_MODEL_CONTEXT_WINDOW,
  'deepseek-chat': 64_000,
  'kimi-k2.5': 256_000,
  'MiniMax-M1': 1_000_000,
  'gemini-2.5-pro-preview-03-25': 1_000_000,
  'llama3.1': DEFAULT_MODEL_CONTEXT_WINDOW,
  'grok-4': DEFAULT_MODEL_CONTEXT_WINDOW,
  'openai/gpt-4o': DEFAULT_MODEL_CONTEXT_WINDOW,
  'anthropic/claude-sonnet-4-5': 200_000,
  'glm-4.6': DEFAULT_MODEL_CONTEXT_WINDOW,
  'qwen-coder-plus-latest': DEFAULT_MODEL_CONTEXT_WINDOW,
};

/** 查表 + fallback */
export function resolveContextWindow(modelName: string | undefined): number {
  if (!modelName) return DEFAULT_MODEL_CONTEXT_WINDOW;
  return MODEL_CONTEXT_WINDOWS[modelName] ?? DEFAULT_MODEL_CONTEXT_WINDOW;
}
