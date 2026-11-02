/**
 * Inbox message validation utilities
 * Message field validation for Messaging
 */

import type { InboxMessage } from '../messaging/types.js';
import type { Priority } from '../messaging/types.js';
import { WireFieldError } from './errors.js';

export const VALID_PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low'];

const SAFE_WIRE_TOKEN = /^[A-Za-z0-9._:-]+$/;

export function assertSafeWireToken(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !SAFE_WIRE_TOKEN.test(value) ||
    value.includes('---') ||
    value.includes('..')
  ) {
    throw new WireFieldError(`unsafe ${field}: must be a single-line [A-Za-z0-9._:-]+ token without --- or ..`);
  }
}

export function validatePriority(value: unknown): Priority {
  if (typeof value === 'string' && VALID_PRIORITIES.includes(value as Priority)) {
    return value as Priority;
  }
  return 'normal';
}

export function validateType(value: unknown): InboxMessage['type'] {
  // Phase 932: strict type validation — non-string or missing values are rejected
  // by the caller (codec-inbox). This helper remains as a thin string cast.
  if (typeof value === 'string') {
    return value as InboxMessage['type'];
  }
  throw new Error(`invalid inbox type: expected string, got ${value === undefined ? 'undefined' : typeof value}`);
}
