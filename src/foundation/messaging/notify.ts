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
import { MOTION_CLAW_ID, UUID_SHORT_LEN } from '../../constants.js';
import { INBOX_PENDING_DIR } from './dirs.js';
import { CLAWS_DIR } from '../claw-paths.js';
import { emitUnknownDestinationDlq } from './audit-emit.js';
import { randomUUID } from 'crypto';


/**
 * NEW: phase 1334 r138 E fork — abstract destination-level inbox notification.
 * Caller expresses targetClawId business semantics; Messaging internally resolves
 * inbox path + codec.
 */
export function notifyClaw(
  fs: FileSystem,
  chestnutRoot: string,  // phase 90: 去 brand type-only import (M#5 单向守、messaging 0 知 L6 brand)
  targetClawId: string,
  message: InboxMessageOptionsBase,
  audit: AuditLog,
): void {
  // phase 1372 sub-4: DLQ for unknown destination — prevent silent orphan dir creation
  if (targetClawId !== MOTION_CLAW_ID && typeof fs.existsSync === 'function') {
    const targetClawRoot = path.join(chestnutRoot, CLAWS_DIR, targetClawId);
    if (!fs.existsSync(targetClawRoot)) {
      const dlqDir = path.join(chestnutRoot, MOTION_CLAW_ID, 'inbox', 'dead-letter');
      const fileName = `${Date.now()}_${randomUUID().slice(0, UUID_SHORT_LEN)}_${targetClawId}.md`;
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
    ? path.join(chestnutRoot, MOTION_CLAW_ID, INBOX_PENDING_DIR)
    : path.join(chestnutRoot, CLAWS_DIR, targetClawId, INBOX_PENDING_DIR);

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
 * @deprecated since phase 1334 — use notifyClaw(fs, chestnutRoot, targetClawId, ...) instead.
 * Caller expressing fs path inboxDir is the wrong abstraction level;
 * cross-claw delivery destination = Messaging business semantics;
 * caller should express targetClawId.
 *
 * @note (per phase 264 reframe): deprecated 仅适用 cross-claw push 场景。
 * self-inbox 写（claw 写自家 inbox / daemon 写自家 inbox）不属 notifyClaw scope
 * （不需 chestnutRoot / targetClawId / DLQ），仍是 by-design use of notifyInbox SoT。
 * 当前 self-inbox by-design caller：deep-dream.ts / heartbeat.ts callback /
 * contract-notify-callback.ts × 3 / daemon-loop.ts。
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

