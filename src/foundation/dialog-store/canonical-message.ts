/**
 * @module L2b.DialogStore.CanonicalMessage
 * phase 1800: 业务 canonical dialog message —— 元数据 owner 自 llm-provider 迁入。
 *
 * phase 436 立、phase 421 ratify（origin/systemSubtype/addedAt/trimmed 4 个 optional
 * 字段）、phase C 消费（24h 边界 + P3 子类型分流 + trimmed 已裁过判）。
 *
 * 归属理由：这些字段是 dialog 消息的生命周期元数据（写入时刻 / 来源 / 裁剪记录），
 * DialogStore 是 dialog 持久化 schema owner；LLMProvider 只见 ProviderWireMessage
 * （role + content）。生产 pi-ai 路径的剥离在 pi-ai-wire.buildPiAiContext 完成；
 * sanitizeForLLMCall 是做同一投影的测试/工具 helper（phase 1961 Step C）。
 */

import type { ProviderWireMessage } from '../llm-provider/index.js';

/**
 * 业务 canonical dialog message = provider wire + chestnut 内部元数据。
 * LLM API 不感知元数据（生产 pi-ai 路径经 buildPiAiContext 投影剥离）。
 */
export interface Message extends ProviderWireMessage {
  /** 仅 role='user' 时有意义；tool_result 不填（内部 block.type 已区分） */
  origin?: 'user' | 'system';

  /** = InboxMessage.type 字面单源、role='user' + origin='system' 时填 */
  systemSubtype?: string;

  /** 消息写入时刻 ISO（24h 边界判断依据、phase C ContextManager 消费） */
  addedAt?: string;

  /**
   * Phase 1955 Step C/D：来源 inbox 消息的稳定身份。
   * 同一业务消息重投递（provider 失败 nack / 幂等重发）不得在 dialog 中重复成两条。
   */
  inboxId?: string;

  /** phase C ContextManager 触发裁剪时填 */
  trimmed?: {
    trimmedAt: string;
    originalContentBytes: number;
    timesTrimmed?: number;
  };
}
