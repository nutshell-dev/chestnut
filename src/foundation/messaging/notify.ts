/**
 * @module L2c.Messaging.Notify
 *
 * Unified notification helpers. Standardizes error handling and formatting for
 * inbox notifications.
 *
 * phase 705: notifyClaw 不再持 chestnut 拓扑知识；target claw 根目录、inbox 目录、
 * dead-letter 目录由 L4+ caller 注入。
 */

import * as path from 'path';
import { InboxWriter, makeInboxPath } from './inbox-writer.js';
import type { InboxMessageOptionsBase } from './inbox-writer.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from './config-schema.js';
import type { InboxMessage } from './types.js';
import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import {
  emitUnknownDestinationDlq,
  emitUnknownDestinationRejected,
} from './audit-emit.js';
import { INBOX_PENDING_DIR } from './dirs.js';

/**
 * Notify a target claw by writing a message to its inbox.
 *
 * @param targetClawRoot - caller-computed target claw root directory
 * @param targetInboxDir - caller-computed target inbox pending directory
 * @param dlqDir - optional dead-letter queue directory; when provided and
 *   targetClawRoot does not exist, the message is routed to dlqDir instead of
 *   creating an orphan claw directory.
 */
export function notifyClaw(
  fs: FileSystem,
  targetClawRoot: string,
  targetInboxDir: string,
  dlqDir: string | undefined,
  message: InboxMessageOptionsBase,
  audit: AuditLog,
): void {
  // phase 936: containment check — targetInboxDir must be inside targetClawRoot
  const resolvedInbox = fs.resolve(targetInboxDir);
  const resolvedRoot = fs.resolve(targetClawRoot);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  const normalizedInbox = path.normalize(resolvedInbox);
  if (normalizedInbox !== resolvedRoot && !normalizedInbox.startsWith(rootPrefix)) {
    throw new Error(
      `notifyClaw: targetInboxDir "${targetInboxDir}" is not within targetClawRoot "${targetClawRoot}"`,
    );
  }

  // phase 937: targetInboxDir must be <root>/inbox/pending specifically
  const expectedSuffix = path.normalize(INBOX_PENDING_DIR);
  if (
    !normalizedInbox.endsWith(expectedSuffix) &&
    normalizedInbox !== resolvedRoot + path.sep + expectedSuffix
  ) {
    throw new Error(
      `notifyClaw: targetInboxDir must be <root>/inbox/pending, got "${targetInboxDir}"`,
    );
  }

  // phase 1170: unknown target fail-closed — never create an orphan claw root
  if (!fs.existsSync(targetClawRoot)) {
    const targetClawId = path.basename(targetClawRoot);

    if (dlqDir !== undefined) {
      try {
        const fileName = InboxWriter.__internal_create(fs, makeInboxPath(dlqDir), audit, MESSAGING_WRITER_LIMITS_DEFAULT).writeSync({
          ...message,
          source: message.source ?? 'unknown',
        });
        emitUnknownDestinationDlq(audit, {
          targetClawId,
          reason: 'claw_not_found',
          file: fileName,
        });
      } catch {
        // InboxWriter already audits write failure; side-channel stays best-effort.
      }
    } else {
      try {
        emitUnknownDestinationRejected(audit, {
          targetClawId,
          reason: 'claw_not_found',
        });
      } catch {
        // silent: audit failure must not reopen delivery to a missing target.
      }
    }

    return;
  }

  try {
    InboxWriter.__internal_create(fs, makeInboxPath(targetInboxDir), audit, MESSAGING_WRITER_LIMITS_DEFAULT).writeSync(message);
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
  await InboxWriter.__internal_create(fs, makeInboxPath(inboxDir), audit, MESSAGING_WRITER_LIMITS_DEFAULT).write(message);
}

/**
 * Send an inbox notification with standardized error handling.
 * Logs warning on failure but does not throw.
 *
 * @deprecated since phase 1334 — use notifyClaw(fs, targetClawRoot, targetInboxDir, dlqDir, ...) instead.
 * Caller expressing fs path inboxDir is the wrong abstraction level;
 * cross-claw delivery destination = Messaging business semantics;
 * caller should express targetClawId.
 *
 * @note (per phase 264 reframe): deprecated 仅适用 cross-claw push 场景。
 * self-inbox 写（claw 写自家 inbox / daemon 写自家 inbox）不属 notifyClaw scope
 * （不需 chestnutRoot / targetClawId / DLQ），仍是 by-design use of notifyInbox SoT。
 * 当前 self-inbox by-design caller：deep-dream.ts / heartbeat.ts callback /
 * assembly/contract-notification-adapter.ts × 3 / daemon-loop.ts。
 */
export function notifyInbox(
  fs: FileSystem,
  opts: InboxMessageOptionsBase & { inboxDir: string },
  audit: AuditLog,
): void {
  try {
    const { inboxDir, ...rest } = opts;
    InboxWriter.__internal_create(fs, makeInboxPath(inboxDir), audit, MESSAGING_WRITER_LIMITS_DEFAULT).writeSync(rest);
  } catch {
    // InboxWriter.writeSync 已 audit INBOX_WRITE_FAILED
    // 此处 catch 是防 TUI raw mode 渲染污染的 best-effort barrier
    // 不 rethrow — notify 是旁路通知，失败不影响主流程
  }
}
