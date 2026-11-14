/**
 * @module L2c.Messaging.Notify
 *
 * Unified notification helpers. Callers identify claws by root; Messaging owns
 * every inbox and dead-letter leaf derivation.
 */

import * as path from 'path';
import { createInboxDeadLetterWriter, createInboxWriter } from './inbox-writer.js';
import type { InboxMessageOptionsBase } from './inbox-writer.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from './config-schema.js';
import type { InboxMessage } from './types.js';
import type { FileSystem } from '../fs/index.js';
import type { MessagingAuditSink } from './audit-sink.js';
import {
  emitUnknownDestinationDlq,
  emitUnknownDestinationRejected,
} from './audit-emit.js';

/**
 * Notify a target claw by writing a message to its inbox.
 *
 * When targetClawRoot does not exist and dlqClawRoot is provided, route to that
 * root's dead-letter queue instead of creating an orphan claw directory.
 */
export function notifyClaw(
  fs: FileSystem,
  targetClawRoot: string,
  dlqClawRoot: string | undefined,
  message: InboxMessageOptionsBase,
  audit: MessagingAuditSink,
): void {
  // phase 1170: unknown target fail-closed — never create an orphan claw root
  if (!fs.existsSync(targetClawRoot)) {
    const targetClawId = path.basename(targetClawRoot);

    if (dlqClawRoot !== undefined) {
      try {
        const fileName = createInboxDeadLetterWriter(fs, dlqClawRoot, audit, MESSAGING_WRITER_LIMITS_DEFAULT).writeSync({
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
    createInboxWriter(fs, targetClawRoot, audit, MESSAGING_WRITER_LIMITS_DEFAULT).writeSync(message);
  } catch {
    // InboxWriter.writeSync already audits INBOX_WRITE_FAILED.
    // This catch is a best-effort barrier against TUI raw-mode render pollution.
    // Do not rethrow — notify is a side-channel, failure must not affect main flow.
  }
}

/**
 * Async inbox write with error propagation.
 * Used by result-delivery where fallback-path retry requires throw semantics.
 *
 * Phase 1869 (Step D) 边界声明（owner 显式契约）：
 * - resolve = 写入已提交（rename 完成）；目录耐久性降级（平台受限 / 未知）不拒绝
 *   写入、不静默——由 `inbox_write_durability_degraded` 审计留证，调用方可观察；
 * - reject = rename 前失败（temp 写入 / fsync / rename），未提交、可安全重试；
 * - 不承诺 exactly-once / 掉电耐久性 / 跨进程互斥（独立 owner 协议面，另行升档）。
 */
export async function writeInboxAsync(
  fs: FileSystem,
  clawRoot: string,
  message: InboxMessage,
  audit: MessagingAuditSink,
): Promise<void> {
  await createInboxWriter(fs, clawRoot, audit, MESSAGING_WRITER_LIMITS_DEFAULT).write(message);
}

/** Send a best-effort inbox notification to a claw root. */
export function notifyInbox(
  fs: FileSystem,
  opts: InboxMessageOptionsBase & { clawRoot: string },
  audit: MessagingAuditSink,
): void {
  try {
    const { clawRoot, ...rest } = opts;
    createInboxWriter(fs, clawRoot, audit, MESSAGING_WRITER_LIMITS_DEFAULT).writeSync(rest);
  } catch {
    // InboxWriter.writeSync 已 audit INBOX_WRITE_FAILED
    // 此处 catch 是防 TUI raw mode 渲染污染的 best-effort barrier
    // 不 rethrow — notify 是旁路通知，失败不影响主流程
  }
}
