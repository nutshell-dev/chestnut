/**
 * @module L6.Assembly.Guidance
 * phase 1469: Composer registration aggregate.
 *
 * 装配期一次性调 `registerAllMotionGuidance(registry)`、按 22 inbox type 显式 register 各 composer.
 * 本 phase β scope = 全 NO_GUIDANCE sentinel 表态、真 composer 推 γN 替换 import 即可、register 调用本身不变.
 *
 * DP「不静默」+ ML#9 显式表达：每 sender type 必显式 register / 漏注由
 * `tests/foundation/assembly/guidance-registry-coverage.test.ts` 抓.
 */

import type { MotionGuidanceRegistry } from '../types.js';

import { composer as crashNotification } from './crash-notification.js';
import { composer as clawInactivity } from './claw-inactivity.js';
import { composer as contractEvents } from './contract-events.js';
import { composer as verificationResult } from './verification-result.js';
import { composer as verificationRejection } from './verification-rejection.js';
import { composer as verificationError } from './verification-error.js';
import { composer as randomDream } from './random-dream.js';
import { composer as deepDream } from './deep-dream.js';
import { composer as heartbeat } from './heartbeat.js';
import { composer as startupCheck } from './startup-check.js';
import { composer as message } from './message.js';
import { composer as taskQueueOverflow } from './task-queue-overflow.js';
import { composer as sunsetReady } from './sunset-ready.js';
import { composer as cronDiskWarning } from './cron-disk-warning.js';
import { composer as auditSizeAlert } from './audit-size-alert.js';
import { composer as userChat } from './user-chat.js';
import { composer as userInboxMessage } from './user-inbox-message.js';
import { composer as report } from './report.js';
import { composer as question } from './question.js';
import { composer as result } from './result.js';
import { composer as errorMsg } from './error.js';
import { composer as response } from './response.js';

export function registerAllMotionGuidance(registry: MotionGuidanceRegistry): void {
  registry.register('crash_notification', crashNotification);
  registry.register('claw_inactivity', clawInactivity);
  registry.register('contract_events', contractEvents);
  registry.register('verification_result', verificationResult);
  registry.register('verification_rejection', verificationRejection);
  registry.register('verification_error', verificationError);
  registry.register('random_dream', randomDream);
  registry.register('deep_dream', deepDream);
  registry.register('heartbeat', heartbeat);
  registry.register('startup_check', startupCheck);
  registry.register('message', message);
  registry.register('task_queue_overflow', taskQueueOverflow);
  registry.register('sunset_ready', sunsetReady);
  registry.register('cron_disk_warning', cronDiskWarning);
  registry.register('audit_size_alert', auditSizeAlert);
  registry.register('user_chat', userChat);
  registry.register('user_inbox_message', userInboxMessage);
  registry.register('report', report);
  registry.register('question', question);
  registry.register('result', result);
  registry.register('error', errorMsg);
  registry.register('response', response);
}
