/**
 * Inbox message validation utilities
 * Message field validation for Messaging
 */

import type { InboxMessage } from '../messaging/types.js';
import type { Priority } from '../messaging/types.js';

export const VALID_PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low'];

export function validatePriority(value: unknown): Priority {
  if (typeof value === 'string' && VALID_PRIORITIES.includes(value as Priority)) {
    return value as Priority;
  }
  return 'normal';
}

export function validateType(value: unknown): InboxMessage['type'] {
  // loose validation：接受任意 string / 防 silent UX drift（M9 phase 575）
  // 保 string 类型 cast / 非 string fallback 'user_inbox_message'（phase 9：'message' catch-all 移除）
  if (typeof value === 'string') {
    return value as InboxMessage['type'];
  }
  return 'user_inbox_message';
}
