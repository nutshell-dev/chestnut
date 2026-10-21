/**
 * @module L1.LLMProvider.PiAi.Success
 *
 * 成功响应的 context 检查（Phase 1959 §4.6 / Phase 1962 Step B；
 * Phase 1964 Step C 自 pi-ai-errors.ts 拆出）。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import type { PiAiRuntime } from './pi-ai-runtime.js';

/** 成功响应的 context 信号（只观测 / 判 length-stop 两类）。 */
export type SuccessContextSignal =
  | { kind: 'silent_overflow'; inputTokens: number; contextWindow: number }
  | { kind: 'length_stop_no_output'; inputTokens: number; contextWindow: number };

/**
 * 成功响应检查（Phase 1959 §4.6）：
 * - length + output=0 + 输入≥99% 窗口 → length_stop_no_output（调用方 throw）；
 * - stop + 输入>窗口 → silent_overflow（调用方只写 audit，不改变响应）。
 *
 * Phase 1962 Step B：判定直接复用 pi-ai 官方 isContextOverflow（case 2/3 与
 * 上述条件等价），不再维护本地阈值；predicate 只给 boolean，silent vs length
 * 仍按 stopReason 分派；stop/length 之外的 stopReason（error/toolUse 等）
 * 不被 success 路径误分类。
 */
export function inspectSuccessfulMessage(
  isOverflow: PiAiRuntime['isContextOverflow'],
  message: PiAi.AssistantMessage,
  contextWindow: number,
): SuccessContextSignal | null {
  if (message.stopReason !== 'length' && message.stopReason !== 'stop') return null;
  if (!isOverflow(message, contextWindow)) return null;
  const inputTokens = message.usage.input + message.usage.cacheRead;
  if (message.stopReason === 'length') {
    return { kind: 'length_stop_no_output', inputTokens, contextWindow };
  }
  return { kind: 'silent_overflow', inputTokens, contextWindow };
}
