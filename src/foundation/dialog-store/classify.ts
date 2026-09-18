/**
 * @module L2b.DialogStore.Classify
 * phase 1861 (CM-D4/CM-D10)：消息事实分类视图——owner（DialogStore，消息 schema 持有者）定义。
 *
 * 视图是**事实**（origin / systemSubtype 的值与存在性）；保护/折叠策略仍归消费方
 * （ContextManager）。消费方经 classifyMessage 消费，不触碰 Message 原始业务字段。
 */

import type { Message } from './canonical-message.js';

/** 消息事实分类视图（业务字段只读投影）。 */
export interface MessageClassifyView {
  /** 消息来源事实（仅 role='user' 时有意义；tool_result 不填）。 */
  readonly origin?: 'user' | 'system';
  /** system 类消息的子类型（= InboxMessage.type 字面，role='user' + origin='system' 时存在）。 */
  readonly systemSubtype?: string;
}

/** 消息事实分类：owner 透出业务字段事实，消费方不直读 Message.origin/systemSubtype。 */
export function classifyMessage(m: Message): MessageClassifyView {
  return { origin: m.origin, systemSubtype: m.systemSubtype };
}
