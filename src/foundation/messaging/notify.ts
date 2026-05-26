/**
 * Notification utilities - Unified notification helpers
 *
 * Standardizes error handling and formatting for inbox notifications.
 */

import * as path from 'path';
import { InboxWriter } from './inbox-writer.js';
import type { InboxMessageOptionsBase } from './inbox-writer.js';
import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { MOTION_CLAW_ID } from '../../constants.js';

/**
 * NEW: phase 1334 r138 E fork — abstract destination-level inbox notification.
 * Caller expresses targetClawId business semantics; Messaging internally resolves
 * inbox path + codec.
 */
export function notifyClaw(
  fs: FileSystem,
  clawforumRoot: string,
  targetClawId: string,
  message: InboxMessageOptionsBase,
  audit: AuditLog,
): void {
  const targetInboxDir = targetClawId === MOTION_CLAW_ID
    ? path.join(clawforumRoot, 'motion', 'inbox', 'pending')
    : path.join(clawforumRoot, 'claws', targetClawId, 'inbox', 'pending');

  try {
    new InboxWriter(fs, targetInboxDir, audit).writeSync(message);
  } catch {
    // InboxWriter.writeSync already audits INBOX_WRITE_FAILED.
    // This catch is a best-effort barrier against TUI raw-mode render pollution.
    // Do not rethrow — notify is a side-channel, failure must not affect main flow.
  }
}

/**
 * Send an inbox notification with standardized error handling.
 * Logs warning on failure but does not throw.
 *
 * @deprecated since phase 1334 — use notifyClaw(fs, clawforumRoot, targetClawId, ...) instead.
 * Caller expressing fs path inboxDir is the wrong abstraction level;
 * cross-claw delivery destination = Messaging business semantics;
 * caller should express targetClawId.
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
    // InboxWriter.writeSync 已 audit INBOX_WRITE_FAILED
    // 此处 catch 是防 TUI raw mode 渲染污染的 best-effort barrier
    // 不 rethrow — notify 是旁路通知，失败不影响主流程
  }
}

/**
 * Send a system message to inbox with high priority.
 * Convenience wrapper for common system notification pattern.
 *
 * @deprecated since phase 1334 — use notifyClaw(fs, clawforumRoot, 'motion', ...) instead.
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
  },
): void {
  notifyInbox(fs, {
    inboxDir,
    type: options?.type ?? 'message',
    source: 'system',
    priority: options?.priority ?? 'high',
    body,
    idPrefix: options?.idPrefix,
  }, audit);
}
