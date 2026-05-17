/**
 * Notification utilities - Unified notification helpers
 *
 * Standardizes error handling and formatting for inbox notifications.
 */

import { InboxWriter } from './inbox-writer.js';
import type { InboxMessageOptionsBase } from './inbox-writer.js';
import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';

/**
 * Send an inbox notification with standardized error handling.
 * Logs warning on failure but does not throw.
 */
export function notifyInbox(
  fs: FileSystem,
  opts: InboxMessageOptionsBase & { inboxDir: string },
  audit: AuditLog,
): void {
  try {
    const { inboxDir, ...rest } = opts;
    new InboxWriter(fs, inboxDir, audit).writeSync(rest);
  } catch {
    // InboxWriter.writeSync 已 audit INBOX_WRITE_FAILED / 此处 catch 静默 best-effort
    // 不 console.warn 防 TUI raw mode 渲染污染（phase 529 Step E 同型 fix / silent X cluster N+1 实证）
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
  audit: AuditLog,
  options?: {
    type?: string;
    priority?: 'critical' | 'high' | 'normal' | 'low';
    idPrefix?: string;
    filenameTag?: string;
  },
): void {
  notifyInbox(fs, {
    inboxDir,
    type: options?.type ?? 'message',
    source: 'system',
    priority: options?.priority ?? 'high',
    body,
    idPrefix: options?.idPrefix,
    filenameTag: options?.filenameTag,
  }, audit);
}


