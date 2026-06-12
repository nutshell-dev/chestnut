/**
 * @module L4.ContextManager
 * Context-exceeded handling: trim first, then escalate to next provider.
 */

import type { Message } from '../../foundation/llm-provider/types.js';
import { trim } from './trim.js';
import type { AuditWriter } from './trim.js';

/**
 * LLM call payload view、由 ContextManager 剪枝后产出。
 *
 * 设计约束（per design/modules/l4_context_manager.md §1.3 不变量 2/3 + DP1）：
 * - `messages` 是 LLM call 的 outbound payload 视图、**不替换 caller 持久化用的 messages 数组**。
 * - caller 应用 `view.messages` 构造 LLMCallOptions、用自己原 messages 引用做 push（assistant / tool_result）+ persist。
 * - 当 `wasTrimmed=false` 时 `messages` 可能与输入同 ref（caller 不应依赖此事实）。
 * - 当 `wasTrimmed=true` 时 `messages` 必然是新 ref。
 * - `readonly` 防 caller 误把 view 当作 push target（编译期约束）。
 */
export interface LLMCallView {
  readonly messages: readonly Message[];
  readonly wasTrimmed: boolean;
}

export function handleContextExceeded(
  messages: Message[],
  systemPrompt: string,
  target: number,
  auditWriter?: AuditWriter,
): LLMCallView {
  const result = trim(messages, systemPrompt, { target }, auditWriter);
  return { messages: result.messages, wasTrimmed: result.droppedCount > 0 };
}
