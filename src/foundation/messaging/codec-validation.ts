/**
 * Inbox message validation utilities
 * Message field validation for Messaging
 */

import type { InboxMessage } from '../messaging/types.js';
import type { Priority } from '../messaging/types.js';

export const VALID_PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low'];
/**
 * 已知 inbox type list — informational only / 不强制（M9 phase 575）。
 * Caller 可写任意 type / decoder loose 接受 / 防 silent UX drift。
 */
export const KNOWN_INBOX_TYPES = [
  'message', 'user_chat', 'user_inbox_message',
  'crash_notification', 'heartbeat', 'claw_outbox',
  'verification_result', 'verification_rejection', 'verification_error',
  'cron_disk_warning', 'random_dream', 'deep_dream',
];

export function validatePriority(value: unknown): Priority {
  if (typeof value === 'string' && VALID_PRIORITIES.includes(value as Priority)) {
    return value as Priority;
  }
  return 'normal';
}

export function validateType(value: unknown): InboxMessage['type'] {
  // loose validation：接受任意 string / 防 silent UX drift（M9 phase 575）
  // 保 string 类型 cast / 非 string 仍 fallback 'message'
  if (typeof value === 'string') {
    return value as InboxMessage['type'];
  }
  return 'message';
}
