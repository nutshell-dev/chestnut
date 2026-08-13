/**
 * @module L2c.Messaging
 * phase 1243: Messaging 自家通用 inbox message type declarations.
 *
 * 当前仅 'user_inbox_message' 由 Messaging own — 它真是 L2 通用消息体（user → claw inbox CLI 入口）。
 */

import type { InboxMessageTypeDeclaration } from './formatter-registry.js';

export const MESSAGING_INBOX_MESSAGE_TYPES = [
  {
    owner: 'messaging',
    type: 'user_inbox_message',
    rendering: { kind: 'standard', presentation: 'user_inbox' },
  },
  // phase 1386: wakeup-delivery job 投到 claw inbox 的定时消息正文。
  {
    owner: 'messaging',
    type: 'wakeup',
    rendering: { kind: 'standard', presentation: 'system' },
  },
] as const satisfies readonly InboxMessageTypeDeclaration[];
