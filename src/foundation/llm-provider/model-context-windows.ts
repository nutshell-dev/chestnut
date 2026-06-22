/**
 * @module L1.LLMProvider.ModelContextWindows
 *
 * Model context window (token) 上限解析。
 *
 * phase 440 在 step-executor 立、phase 453 抽 L1（M#3 model 字面与 LLM API 协议层同源）、
 * phase 684 改为「默认 256K + 子串特判 1M」机制（替代精确 model 名映射、避免表 stale）。
 *
 * 注：本表是各 provider model 的 context window 字面值、不是裁剪相关业务字面；
 * 归 L1 LLMProvider、非 L4 ContextManager。
 */

/** 默认 context window（model 名未命中 1M 特判时 fallback、phase 684 改 128K → 256K） */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 256_000;

/**
 * Model 名含以下任一子串即视为 1M context window。
 * phase 684 立：用子串特判替代具体 model 名映射、避免表 stale（model 命名快速演进）。
 * 大小写敏感（按用户拍板的字面值匹配）。
 */
const MILLION_TOKEN_PATTERNS: readonly string[] = [
  'claude',
  'gemini',
  'deepseek-v4',
  'glm-5',
  'MiniMax-M3',
] as const;

/** 解析 model 名对应的 context window 上限 */
export function resolveContextWindow(modelName: string | undefined): number {
  if (!modelName) return DEFAULT_MODEL_CONTEXT_WINDOW;
  for (const pattern of MILLION_TOKEN_PATTERNS) {
    if (modelName.includes(pattern)) return 1_000_000;
  }
  return DEFAULT_MODEL_CONTEXT_WINDOW;
}
