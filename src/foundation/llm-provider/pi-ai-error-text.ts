/**
 * @module L1.LLMProvider.PiAi.ErrorText
 *
 * capture 原文 → pi-ai 官方 predicate 的文本 shim（Phase 1960 Step B；
 * Phase 1964 Step C 自 pi-ai-errors.ts 拆出）。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import type { PiAiRuntime } from './pi-ai-runtime.js';

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
    errorMessage: text,
    provider,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  } as unknown as PiAi.AssistantMessage;
  return isOverflow(probe);
}
