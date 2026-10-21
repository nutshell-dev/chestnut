/**
 * @module L1.LLMProvider.Sanitize
 * 测试/工具投影 helper：剥离 chestnut 内部元数据、产协议合规 payload。
 *
 * phase 436 立（phase 421 ratify）：Message schema 加 origin/systemSubtype/addedAt/trimmed
 * 4 个 optional 字段、API 不感知。
 *
 * phase 1961 Step C 名实核对：本函数生产零调用——生产 pi-ai 路径的 wire 投影
 * 在 pi-ai-wire.buildPiAiContext（重建每条消息，只取 role/content）。本 helper
 * 的消费方是 6 个测试文件（含 arch ratchet llm-message-projection）；P1 再决定
 * 是否显式接入生产或把 ratchet 改写指向 buildPiAiContext。
 */

import type { ProviderWireMessage } from './types.js';

/**
 * phase 1800: provider 边界 wire projection 的纯函数（显式剥离点）。
 *
 * - 输入可为 canonical Message（结构超集），输出严格 ProviderWireMessage
 * - 移除 origin / systemSubtype / addedAt / trimmed 等上层元数据
 * - 不改 role / content（仅这两个字段进 LLM API）
 * - 返新数组、不动 caller 持有的引用（防止 LLM call 路径污染 dialog 持久化引用）
 * - 生产路径不用本函数：pi-ai wire 投影见 pi-ai-wire.buildPiAiContext
 */
export function sanitizeForLLMCall(messages: readonly ProviderWireMessage[]): ProviderWireMessage[] {
  return messages.map(m => ({ role: m.role, content: m.content }));
}
