/**
 * @module L1.LLMProvider.Sanitize
 * 给 LLM API 调用前剥离 chestnut 内部元数据、产协议合规 payload。
 *
 * phase 436 立（phase 421 ratify）：Message schema 加 origin/systemSubtype/addedAt/trimmed
 * 4 个 optional 字段、API 不感知、调用前必经此 helper。
 */

import type { Message } from './types.js';

/**
 * 剥离 chestnut 内部元数据、产 LLM API 协议合规的 messages payload。
 *
 * - 移除 origin / systemSubtype / addedAt / trimmed 字段
 * - 不改 role / content（仅这两个字段进 LLM API）
 * - 返新数组、不动 caller 持有的引用（防止 LLM call 路径污染 dialog 持久化引用）
 */
export function sanitizeForLLMCall(messages: readonly Message[]): Message[] {
  return messages.map(m => ({ role: m.role, content: m.content }));
}
