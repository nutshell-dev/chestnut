/**
 * @module L1.LLMProvider.PiAi.Success
 *
 * 成功响应的 context 检查（Phase 1959 §4.6 / Phase 1962 Step B；
 * Phase 1964 Step C 自 pi-ai-errors.ts 拆出；Phase 2012 改判：
 * 所有成功 stopReason + cacheWrite + silent 抛 typed error）。
 */

import type * as PiAi from '@earendil-works/pi-ai';
import type { PiAiRuntime } from './pi-ai-runtime.js';

/** 成功响应的 context 信号（silent / length-stop 两类；error/aborted/pending 不进入）。 */
export type SuccessContextSignal =
  | { kind: 'silent_overflow'; inputTokens: number; contextWindow: number }
  | { kind: 'length_stop_no_output'; inputTokens: number; contextWindow: number };

/**
 * 成功响应检查：length + output=0 + 输入≥99% 窗口，或任意成功完成态输入>窗口。
 * 判定复用 pi-ai 官方 isContextOverflow，本地不维护第二套阈值。
 */
export function inspectSuccessfulMessage(
  isOverflow: PiAiRuntime['isContextOverflow'],
  message: PiAi.AssistantMessage,
  contextWindow: number,
): SuccessContextSignal | null {
  // error 由错误路径分类；aborted 由中止路径处理；pending 不是完成态。
  if (
    message.stopReason === 'error'
    || message.stopReason === 'aborted'
    || message.stopReason === 'pending'
  ) {
    return null;
  }

  const inputTokens =
    message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;

  // 只用于上游 predicate：cacheWrite 折入 input；非 length 的成功 stopReason
  // 归一为 stop，让 Case 2（成功但 usage 超窗）覆盖 toolUse / deferred。
  const predicateMessage = {
    ...message,
    stopReason: message.stopReason === 'length' ? 'length' : 'stop',
    usage: {
      ...message.usage,
      input: inputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + message.usage.output,
    },
  } as PiAi.AssistantMessage;

  if (!isOverflow(predicateMessage, contextWindow)) return null;
  if (message.stopReason === 'length') {
    return { kind: 'length_stop_no_output', inputTokens, contextWindow };
  }
  return { kind: 'silent_overflow', inputTokens, contextWindow };
}
