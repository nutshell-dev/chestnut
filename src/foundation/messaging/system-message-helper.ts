/**
 * @module L2c.Messaging.SystemMessageHelper
 * phase 436 立（phase 421 ratify）：基于 Message.origin 字段的 system/user 消息识别 helper。
 *
 * 与字面前缀的关系：
 * - inbox-formatter 仍生成 `[system message<t>] <body>` 字面前缀给 LLM 看（LLM 凭文本识别系统通知）
 * - chestnut 内部判断走 msg.origin 元数据字段（更稳定、不靠字面 grep）
 * - 老 dialog 无 origin 字段时 isSystemMessage 返 false（安全语义）
 * phase 1889 Step D：旧 SYSTEM_MESSAGE_PREFIX re-export 删除——消费方直引 templates/messages。
 */

import type { Message } from '../dialog-store/index.js';

/** 是否为系统消息（user role + origin='system'） */
export function isSystemMessage(msg: Message): boolean {
  return msg.role === 'user' && msg.origin === 'system';
}

/** 是否为真用户意图消息（user role + origin='user'） */
export function isUserMessage(msg: Message): boolean {
  return msg.role === 'user' && msg.origin === 'user';
}
