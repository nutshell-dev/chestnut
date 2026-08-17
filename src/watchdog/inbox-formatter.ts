/**
 * @module L6.Watchdog
 * phase 1243: Watchdog 自家 inbox 消息 rendering declarations。
 *
 * Phase 1396 Step F: claw_crashed / claw_inactivity guidance 已退役；旧 inbox 中的历史
 * 消息由 Runtime 通用 fallback 读取，不阻塞 drain。二者仍保留 standard system rendering
 * 声明，以满足 inbox formatter registry coverage invariant。
 */

import type { InboxMessageTypeDeclaration } from '../foundation/messaging/index.js';

export const WATCHDOG_INBOX_MESSAGE_TYPES = [
  {
    owner: 'watchdog',
    type: 'claw_crashed',
    rendering: { kind: 'standard', presentation: 'system' },
  },
  {
    owner: 'watchdog',
    type: 'claw_inactivity',
    rendering: { kind: 'standard', presentation: 'system' },
  },
] as const satisfies readonly InboxMessageTypeDeclaration[];
