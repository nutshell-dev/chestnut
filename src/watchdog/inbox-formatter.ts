/**
 * @module L6.Watchdog
 * phase 1414: Watchdog 自家 'claw_crashed' inbox 消息 formatter。
 * phase 1419: 加 sister `'claw_inactivity'` formatter + unify register helper（落地完整化）。
 * phase 4 重写 (chestnut era): drop claw_crashed preamble "Claw X process exited abnormally"
 *   - 与新 body 自含完整语义重复 + 对 user_stopped sub-class 字面误导
 *   - 改为统一 wrap pattern (与 claw_inactivity 一致)
 *
 * 业务语义全归 Watchdog：
 *   - 'claw_crashed'  claw 死给 motion 的通知 / body 含 CrashClass-specific 自含语义
 *   - 'claw_inactivity' claw 活但 stuck 给 motion 的通知 / body 含 FailureClass-specific 自含语义
 */

import type { MessageFormatter, MessageFormatterRegistry } from '../foundation/messaging/index.js';

export const formatClawCrashed: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export const formatClawInactivity: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export function registerWatchdogFormatters(registry: MessageFormatterRegistry): void {
  registry.register('claw_crashed', formatClawCrashed);
  registry.register('claw_inactivity', formatClawInactivity);
}
