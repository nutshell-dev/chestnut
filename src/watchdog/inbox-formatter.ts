/**
 * @module L6.Watchdog
 * phase 1243: Watchdog 自家 inbox 消息 rendering declarations。
 *
 * Phase 1396 Step F: claw_crashed / claw_inactivity guidance 已退役；旧 inbox 中的历史
 * 消息由 Runtime 通用 fallback 读取，不阻塞 drain。本模块不再声明该两类消息。
 */

import type { InboxMessageTypeDeclaration } from '../foundation/messaging/index.js';

export const WATCHDOG_INBOX_MESSAGE_TYPES = [] as const satisfies readonly InboxMessageTypeDeclaration[];
