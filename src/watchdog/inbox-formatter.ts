/**
 * @module L6.Watchdog
 * phase 1243: Watchdog 自家 inbox 消息 rendering declarations。
 *
 * 业务语义全归 Watchdog：
 *   - 'claw_inactivity' claw 活但 stuck 给 motion 的通知 / body 含 FailureClass-specific 自含语义
 *   （phase 1380: 'claw_crashed' 退场——claw 崩溃自愈归系统、不再投 motion inbox、audit-only）
 */

import type { InboxMessageTypeDeclaration } from '../foundation/messaging/index.js';

export const WATCHDOG_INBOX_MESSAGE_TYPES = [
  { owner: 'watchdog', type: 'claw_inactivity', rendering: { kind: 'standard', presentation: 'system' } },
] as const satisfies readonly InboxMessageTypeDeclaration[];
