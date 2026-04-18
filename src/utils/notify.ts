/**
 * Notification utilities - Unified notification helpers
 *
 * Standardizes error handling and formatting for inbox notifications.
 */

import { writeInboxMessage, type InboxMessageOptionsBase } from './inbox-writer.js';
import type { FileSystem } from '../foundation/fs/types.js';
import type { Audit } from '../foundation/audit/index.js';
import * as fsNative from 'fs';

/**
 * Send an inbox notification with standardized error handling.
 * Logs warning on failure but does not throw.
 */
export function notifyInbox(
  fs: FileSystem,
  opts: InboxMessageOptionsBase & { inboxDir: string },
  audit: Audit,
  context?: string,
): void {
  try {
    writeInboxMessage(fs, { ...opts, audit });
  } catch (e) {
    const prefix = context ? `[${context}] ` : '';
    console.warn(`${prefix}Failed to send inbox notification:`, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Send a system message to inbox with high priority.
 * Convenience wrapper for common system notification pattern.
 */
export function notifySystem(
  fs: FileSystem,
  inboxDir: string,
  body: string,
  audit: Audit,
  options?: {
    type?: string;
    priority?: 'critical' | 'high' | 'normal' | 'low';
    idPrefix?: string;
    filenameTag?: string;
  },
  context?: string,
): void {
  notifyInbox(fs, {
    inboxDir,
    type: options?.type ?? 'message',
    source: 'system',
    priority: options?.priority ?? 'high',
    body,
    idPrefix: options?.idPrefix,
    filenameTag: options?.filenameTag,
  }, audit, context);
}

/**
 * Append to stream.jsonl with standardized error handling (best-effort).
 */
export function notifyStream(streamPath: string, line: string, context?: string): void {
  try {
    fsNative.appendFileSync(streamPath, line);
  } catch (e) {
    const prefix = context ? `[${context}] ` : '';
    console.warn(`${prefix}Failed to append to stream:`, e instanceof Error ? e.message : String(e));
  }
}
