/**
 * @module L1.LLMProvider.Sanitize
 * 给 LLM API 调用前剥离 chestnut 内部元数据、产协议合规 payload。
 *
 * phase 436 立（phase 421 ratify）：Message schema 加 origin/systemSubtype/addedAt/trimmed
 * 4 个 optional 字段、API 不感知、调用前必经此 helper。
 */

import type { ProviderWireMessage } from './types.js';

/**
 * phase 1800: 本函数即 provider 边界 wire projection（显式剥离点）。
 *
 * - 输入可为 canonical Message（结构超集），输出严格 ProviderWireMessage
 * - 移除 origin / systemSubtype / addedAt / trimmed 等上层元数据
 * - 不改 role / content（仅这两个字段进 LLM API）
 * - 返新数组、不动 caller 持有的引用（防止 LLM call 路径污染 dialog 持久化引用）
 */
export function sanitizeForLLMCall(messages: readonly ProviderWireMessage[]): ProviderWireMessage[] {
  return messages.map(m => ({ role: m.role, content: m.content }));
}
