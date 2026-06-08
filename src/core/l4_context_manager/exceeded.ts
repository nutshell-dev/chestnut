/**
 * @module L4.ContextManager
 * Context-exceeded handling: trim first, then escalate to next provider.
 *
 * Internally defaults to allowCacheBreak=true for second-pass trim
 * (agent progress > cache hit).
 */

import type { Message } from '../../foundation/llm-provider/types.js';
import { trim } from './trim.js';
import {
  ContextTrimInsufficientWithoutCacheBreakError,
} from './errors.js';
import { CACHE_INVALIDATED_BY_DEEP_TRIM } from './audit-events.js';
import type { AuditWriter } from './trim.js';

export function handleContextExceeded(
  messages: Message[],
  systemPrompt: string,
  target: number,
  auditWriter?: AuditWriter,
): Message[] {
  try {
    return trim(messages, systemPrompt, { target, allowCacheBreak: false }, auditWriter).messages;
  } catch (e) {
    if (e instanceof ContextTrimInsufficientWithoutCacheBreakError) {
      const result = trim(messages, systemPrompt, { target, allowCacheBreak: true }, auditWriter);
      auditWriter?.write(CACHE_INVALIDATED_BY_DEEP_TRIM, `dropped=${result.droppedCount}`, `cacheBroken=${result.cacheBroken}`);
      return result.messages;
    }
    throw e;
  }
}
