/**
 * @module L2b.DialogStore.CanonicalMessage
 * phase 1800: 业务 canonical dialog message —— 元数据 owner 自 llm-provider 迁入。
 *
 * phase 436 立、phase 421 ratify（origin/systemSubtype/addedAt/trimmed 4 个 optional
 * 字段）、phase C 消费（24h 边界 + P3 子类型分流 + trimmed 已裁过判）。
 *
 * 归属理由：这些字段是 dialog 消息的生命周期元数据（写入时刻 / 来源 / 裁剪记录），
 * DialogStore 是 dialog 持久化 schema owner；LLMProvider 只见 ProviderWireMessage
 * （role + content），provider 边界经 sanitizeForLLMCall 单向剥离。
 */

import type { ProviderWireMessage } from '../llm-provider/index.js';

/**
 * 业务 canonical dialog message = provider wire + chestnut 内部元数据。
 * LLM API 不感知元数据（调用前必经 sanitize 投影）。
 */
export interface Message extends ProviderWireMessage {
  /** 仅 role='user' 时有意义；tool_result 不填（内部 block.type 已区分） */
  origin?: 'user' | 'system';

  /** = InboxMessage.type 字面单源、role='user' + origin='system' 时填 */
  systemSubtype?: string;

  /** 消息写入时刻 ISO（24h 边界判断依据、phase C ContextManager 消费） */
  addedAt?: string;

  /** phase C ContextManager 触发裁剪时填 */
  trimmed?: {
    trimmedAt: string;
    originalContentBytes: number;
    timesTrimmed?: number;
  };
}
