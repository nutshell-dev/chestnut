/**
 * @module L2.Messaging
 * Messaging module (L2)
 *
 * Inbox/outbox directory management, message delivery and retrieval.
 * Dependencies: FileSystem
 */

export { OutboxWriter, makeOutboxPath } from './outbox-writer.js';
export type { OutboxWriteOptions, OutboxPath } from './outbox-writer.js';

export { InboxWriter, makeInboxPath } from './inbox-writer.js';
export type { InboxMessageOptionsBase, InboxMessageMeta, InboxPath } from './inbox-writer.js';

export { InboxReader } from './inbox-reader.js';
export type { InboxEntry } from './inbox-reader.js';
export type { InboxHandle } from './types.js';
export { InboxListFailed, InboxMoveFailed } from './errors.js';
export type { InboxMoveOp, InboxMetaError } from './errors.js';

import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { InboxReader } from './inbox-reader.js';
import { OutboxWriter, makeOutboxPath } from './outbox-writer.js';

export function createInboxReader(
  fs: FileSystem,
  audit: AuditLog,
  baseDir: string,
): InboxReader {
  // β 方案：三子目录名是 Messaging 模块不可变约定（phase148），工厂固定拼接。
  // ctor 顺序 (pendingDir, doneDir, failedDir, fs, audit, inflightDir)，工厂内部适配。
  return new InboxReader(
    `${baseDir}/pending`,
    `${baseDir}/done`,
    `${baseDir}/failed`,
    fs,
    audit,
    `${baseDir}/inflight`,
  );
}

export function createOutboxWriter(
  clawId: ClawId,
  clawDir: string,
  fs: FileSystem,
  audit: AuditLog,
): OutboxWriter {
  return OutboxWriter.__internal_create(clawId, makeOutboxPath(clawId, clawDir), fs, audit);
}

export { emitOutboxSent, emitOutboxSendFailed } from './audit-emit.js';

export { notifyInbox, notifySystem, notifyClaw, writeInboxAsync } from './notify.js';

import type { ClawId } from '../identity/index.js';
import * as path from 'path';
import { INBOX_DONE_DIR, INBOX_FAILED_DIR } from './dirs.js';
import { MESSAGING_AUDIT_EVENTS } from './audit-events.js';
import {
  drainOutboxes,
  type DrainOutboxesOptions,
  type DrainResult,
} from './drain-outboxes.js';
export { drainOutboxes, type DrainOutboxesOptions, type DrainResult };

export interface Messaging {
  drainOutboxes(opts: { limitPerClaw?: number; signal?: AbortSignal }): Promise<DrainResult>;
}

export function createMessaging(deps: {
  clawforumDir: string;
  fs: FileSystem;
  audit: AuditLog;
}): Messaging {
  return {
    drainOutboxes: async (opts) =>
      drainOutboxes({
        clawforumDir: deps.clawforumDir,
        fs: deps.fs,
        audit: deps.audit,
        limitPerClaw: opts.limitPerClaw,
        signal: opts.signal,
      }),
  };
}

export async function cleanupRetention(opts: {
  motionDir: string;
  fs: FileSystem;
  audit: AuditLog;
  maxDays: { inbox?: number; outbox?: number };
  signal?: AbortSignal;
}): Promise<number> {
  const { motionDir, fs, audit, maxDays, signal } = opts;
  const now = Date.now();
  let totalDeleted = 0;

  const dirs: Array<{ relPath: string; maxDaysKey: 'inbox' | 'outbox' }> = [
    { relPath: INBOX_DONE_DIR, maxDaysKey: 'inbox' },
    { relPath: INBOX_FAILED_DIR, maxDaysKey: 'inbox' },
    { relPath: 'outbox/done', maxDaysKey: 'outbox' },
    { relPath: 'outbox/failed', maxDaysKey: 'outbox' },
  ];

  for (const { relPath, maxDaysKey } of dirs) {
    if (signal?.aborted) break;
    const maxD = maxDays[maxDaysKey];
    if (!maxD) continue;

    const dir = path.join(motionDir, relPath);
    if (!fs.existsSync(dir)) continue;

    const cutoff = now - maxD * 24 * 60 * 60 * 1000;
    try {
      for (const entry of fs.listSync(dir)) {
        if (signal?.aborted) break;
        if (entry.isDirectory) continue;
        try {
          const stats = fs.statSync(path.join(dir, entry.name));
          if (stats.mtime.getTime() < cutoff) {
            fs.deleteSync(path.join(dir, entry.name));
            totalDeleted++;
          }
        } catch (err) {
          audit.write(MESSAGING_AUDIT_EVENTS.RETENTION_CLEANUP_DELETE_FAILED, `context=per-file`, `dir=${dir}`, `file=${entry.name}`, `reason=${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      audit.write(MESSAGING_AUDIT_EVENTS.RETENTION_CLEANUP_DELETE_FAILED, `context=per-dir`, `dir=${dir}`, `reason=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return totalDeleted;
}
