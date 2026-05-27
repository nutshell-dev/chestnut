/**
 * Notification utilities - Unified notification helpers
 *
 * Standardizes error handling and formatting for inbox notifications.
 */

import * as path from 'path';
import { InboxWriter, makeInboxPath } from './inbox-writer.js';
import type { InboxMessageOptionsBase } from './inbox-writer.js';
import type { InboxMessage } from './types.js';
import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { MOTION_CLAW_ID } from '../../constants.js';
import { emitUnknownDestinationDlq } from './audit-emit.js';
import { randomUUID } from 'crypto';


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
  // phase 1372 sub-4: DLQ for unknown destination — prevent silent orphan dir creation
  if (targetClawId !== MOTION_CLAW_ID && typeof fs.existsSync === 'function') {
    const targetClawRoot = path.join(clawforumRoot, 'claws', targetClawId);
    if (!fs.existsSync(targetClawRoot)) {
      const dlqDir = path.join(clawforumRoot, MOTION_CLAW_ID, 'inbox', 'dead-letter');
      const fileName = `${Date.now()}_${randomUUID().slice(0, 8)}_${targetClawId}.md`;
      const dlqPath = path.join(dlqDir, fileName);
      try {
        fs.ensureDirSync(dlqDir);
        InboxWriter.__internal_create(fs, makeInboxPath(dlqDir), audit).writeSync({
          ...message,
          source: message.source ?? 'unknown',
        });
        emitUnknownDestinationDlq(audit, {
          targetClawId,
          reason: 'claw_not_found',
          file: fileName,
        });
      } catch {
        // silent: best-effort DLQ write; do not rethrow.
      }
      return;
    }
  }

  const targetInboxDir = targetClawId === MOTION_CLAW_ID
    ? path.join(clawforumRoot, MOTION_CLAW_ID, 'inbox', 'pending')
    : path.join(clawforumRoot, 'claws', targetClawId, 'inbox', 'pending');

  try {
    InboxWriter.__internal_create(fs, makeInboxPath(targetInboxDir), audit).writeSync(message);
  } catch {
    // InboxWriter.writeSync already audits INBOX_WRITE_FAILED.
    // This catch is a best-effort barrier against TUI raw-mode render pollution.
    // Do not rethrow — notify is a side-channel, failure must not affect main flow.
  }
}

/**
 * Async inbox write with error propagation.
 * Used by result-delivery where fallback-path retry requires throw semantics.
 * Kept in Messaging module so InboxWriter direct construct stays within module boundary.
 */
export async function writeInboxAsync(
  fs: FileSystem,
  inboxDir: string,
  message: InboxMessage,
  audit: AuditLog,
): Promise<void> {
  await InboxWriter.__internal_create(fs, makeInboxPath(inboxDir), audit).write(message);
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
    InboxWriter.__internal_create(fs, makeInboxPath(inboxDir), audit).writeSync(rest);
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
 * @deprecated since phase 1334 — use notifyClaw(fs, clawforumRoot, MOTION_CLAW_ID, ...) instead.
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
