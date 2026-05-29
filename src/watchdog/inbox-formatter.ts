/**
 * @module L6.Watchdog
 * phase 1414: Watchdog 自家 'crash_notification' inbox 消息 formatter。
 * phase 1419: 加 sister `'claw_inactivity'` formatter + unify register helper（落地完整化）。
 *
 * 业务语义全归 Watchdog：
 *   - 'crash_notification'  claw crash 后给 motion 发的通知（"Claw X process exited abnormally..."）
 *   - 'claw_inactivity'     claw 长期无进展时的不活动通知（body 已含 "Claw X no progress for Nm..."）
 */

import type { MessageFormatter, MessageFormatterRegistry } from '../foundation/messaging/index.js';

export const formatCrashNotification: MessageFormatter = async ({ from, body, timestampSec }) =>
  `[system message${timestampSec}] Claw "${from}" process exited abnormally.\n${body}`;

export const formatClawInactivity: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export function registerWatchdogFormatters(registry: MessageFormatterRegistry): void {
  registry.register('crash_notification', formatCrashNotification);
  registry.register('claw_inactivity', formatClawInactivity);
}
