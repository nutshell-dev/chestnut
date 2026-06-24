/**
 * @module L2c.Messaging
 * phase 1414: Messaging 自家通用 inbox formatter (user_inbox_message).
 * phase 9: 'message' catch-all formatter 移除 / 拆 4 typed event 各业主 own.
 *
 * 当前仅 'user_inbox_message' 由 Messaging own — 它真是 L2 通用消息体（user → claw inbox CLI 入口）.
 */

import type { MessageFormatter, MessageFormatterRegistry } from './formatter-registry.js';

export const formatUserInboxMessage: MessageFormatter = async ({ body, timestampSec }) =>
  `[user inbox message${timestampSec}]\n${body}`;

export function registerMessagingFormatters(registry: MessageFormatterRegistry): void {
  registry.register('user_inbox_message', formatUserInboxMessage);
}
