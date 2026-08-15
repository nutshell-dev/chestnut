/**
 * @module L6.Watchdog
 * phase 1243: Watchdog 自家 inbox 消息 rendering declarations。
 *
 * 业务语义全归 Watchdog：
 *   - 'claw_crashed'  claw 死给 motion 的通知 / body 含 CrashClass-specific 自含语义
 *   - 'claw_inactivity' claw 活但 stuck 给 motion 的通知 / body 含 FailureClass-specific 自含语义
 */

import type { InboxMessageTypeDeclaration } from '../foundation/messaging/index.js';

export const WATCHDOG_INBOX_MESSAGE_TYPES = [
  { owner: 'watchdog', type: 'claw_crashed', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'watchdog', type: 'claw_inactivity', rendering: { kind: 'standard', presentation: 'system' } },
] as const satisfies readonly InboxMessageTypeDeclaration[];
