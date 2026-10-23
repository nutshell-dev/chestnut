/**
 * @module L1.LLMProvider.PiAi.ErrorText
 *
 * capture 原文 → pi-ai 官方 predicate 的文本 shim（Phase 1960 Step B；
 * Phase 1964 Step C 自 pi-ai-errors.ts 拆出）。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import type { PiAiRuntime } from './pi-ai-runtime.js';

/**
 * Phase 1977: pi-ai 0.87.1/1.4.0 的 Kimi 规则是
 * `/exceeded model token limit/i`；实际文案在 exceeded 后插入 model id
 * （"exceeded k3-256k model token limit"）导致 miss。这里只修文本形态，
 * 判定仍由上游 predicate 完成；上游修复后可删。
 *
 * 短语锚定 `exceeded <单个 token> model token limit`，不扩到其他 provider 文案。
 */
const KIMI_MODEL_TOKEN_LIMIT_RE = /\bexceeded\s+\S+\s+model token limit\b/gi;

/** 归一化 Kimi 带 model id 的 token limit 文案（幂等；上游命中时无副作用）。 */
export function normalizeKimiModelTokenLimitText(text: string): string {
  return text.replace(KIMI_MODEL_TOKEN_LIMIT_RE, 'exceeded model token limit');
}

/**
 * 将 capture 原始 body 作为 errorMessage 喂给 pi-ai 官方 predicate。
 * isContextOverflow 的 error 分支只读 stopReason/errorMessage/provider/usage，
 * 其余字段不参与判定；此 shim 是 L1 唯一的类型跨界点，不复制 pattern 列表。
 */
export function isPiAiContextOverflowText(
  isOverflow: PiAiRuntime['isContextOverflow'],
  provider: string,
  text: string,
): boolean {
  const probe = {
    stopReason: 'error',
    errorMessage: normalizeKimiModelTokenLimitText(text),
    provider,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  } as unknown as PiAi.AssistantMessage;
  return isOverflow(probe);
}
