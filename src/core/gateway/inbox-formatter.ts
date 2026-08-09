/**
 * @module L5.Gateway
 * phase 1243: Gateway 自家 'user_chat' inbox 消息 rendering declaration。
 *
 * 业务语义 = "用户 chat 消息怎么对 LLM 呈现"、Gateway 是 user input 业主。
 * 透传 body 无前缀（user_chat 消息体已是用户原文 / Gateway 不加装饰）。
 */

import type { InboxMessageTypeDeclaration } from '../../foundation/messaging/index.js';

export const GATEWAY_INBOX_MESSAGE_TYPES = [
  {
    owner: 'gateway',
    type: 'user_chat',
    rendering: { kind: 'standard', presentation: 'user_chat' },
  },
] as const satisfies readonly InboxMessageTypeDeclaration[];
