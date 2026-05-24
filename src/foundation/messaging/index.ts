/**
 * @module L2.Messaging
 * Messaging module (L2)
 *
 * Inbox/outbox directory management, message delivery and retrieval.
 * Dependencies: FileSystem
 */

export { OutboxWriter } from './outbox-writer.js';
export type { OutboxWriteOptions } from './outbox-writer.js';

export { InboxWriter } from './inbox-writer.js';
export type { InboxMessageOptionsBase, InboxMessageMeta } from './inbox-writer.js';

export { InboxReader } from './inbox-reader.js';
export type { InboxEntry } from './inbox-reader.js';
export { InboxListFailed, InboxMoveFailed } from './errors.js';
export type { InboxMoveOp, InboxMetaError } from './errors.js';

import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { InboxReader } from './inbox-reader.js';
import { OutboxWriter } from './outbox-writer.js';

export function createInboxReader(
  fs: FileSystem,
  audit: AuditLog,
  baseDir: string,
): InboxReader {
  // β 方案：三子目录名是 Messaging 模块不可变约定（phase148），工厂固定拼接。
  // ctor 顺序 (pendingDir, doneDir, failedDir, fs, audit)，工厂内部适配。
  return new InboxReader(
    `${baseDir}/pending`,
    `${baseDir}/done`,
    `${baseDir}/failed`,
    fs,
    audit,
  );
}

export function createOutboxWriter(
  clawId: string,
  clawDir: string,
  fs: FileSystem,
  audit: AuditLog,
): OutboxWriter {
  return new OutboxWriter(clawId, clawDir, fs, audit);
}

export { emitOutboxSent, emitOutboxSendFailed } from './audit-emit.js';

export { notifyInbox, notifySystem } from './notify.js';
