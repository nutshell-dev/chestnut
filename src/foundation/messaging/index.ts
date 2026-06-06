/**
 * @module L2.Messaging
 * Messaging module (L2)
 *
 * Inbox/outbox directory management, message delivery and retrieval.
 * Dependencies: FileSystem
 */

export { OutboxWriter, makeOutboxPath } from './outbox-writer.js';
export type { OutboxWriteOptions, OutboxPath } from './outbox-writer.js';

// phase 42: outbox 读侧（业主入口、用于聚合查询如 outbox-summary 未读计数）
export { OutboxReader } from './outbox-reader.js';

export { InboxWriter, makeInboxPath } from './inbox-writer.js';
export type { InboxMessageOptionsBase, InboxMessageMeta, InboxPath } from './inbox-writer.js';

export { InboxReader } from './inbox-reader.js';
export type { InboxEntry } from './inbox-reader.js';
export type { InboxHandle, OutboxMessage } from './types.js';
export { InboxListFailed, InboxMoveFailed } from './errors.js';
export type { InboxMoveOp, InboxMetaError } from './errors.js';

// phase 1423 F4: dirs path const re-export — 跨模块 (daemon / core) 路径合成走 barrel。
// sister L2 foundation/paths.ts 内部 sister 保留 deep import (depcruise rule allowlist)。
export {
  INBOX_PENDING_DIR,
  INBOX_DONE_DIR,
  INBOX_FAILED_DIR,
  INBOX_INFLIGHT_DIR,
  OUTBOX_PENDING_DIR,
} from './dirs.js';

// phase 1435 F8: audit events const re-export — 跨模块 (cli / daemon) 引用走 barrel。
export { MESSAGING_AUDIT_EVENTS } from './audit-events.js';

// phase 1414: inbox 消息格式化协议（散到各业主自管）
export { createMessageFormatterRegistry } from './formatter-registry.js';
export type {
  MessageFormatter,
  MessageFormatterRegistry,
  MessageFormatterContext,
} from './formatter-registry.js';
export {
  formatUserInboxMessage,
  registerMessagingFormatters,
} from './inbox-formatters.js';

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
  clawId: string,
  clawDir: string,
  fs: FileSystem,
  audit: AuditLog,
): OutboxWriter {
  return OutboxWriter.__internal_create(clawId, makeOutboxPath(clawId, clawDir), fs, audit);
}

export { emitOutboxSent, emitOutboxSendFailed } from './audit-emit.js';

export { notifyInbox, notifySystem, notifyClaw, writeInboxAsync } from './notify.js';


// phase 1476: drainOutboxes / Messaging / createMessaging 全砍。
// claw→motion 通信改 pull 模型（motion 见 claw_outbox_summary 索引 → CLI claw <id> outbox 拉取消费）。
// claw→claw 通信通道暂闭（claw 不知其他 claw 名字 / send tool to: 写死 motion）。
// 详 design/modules/l2_messaging.md §7.A A.phase1476-drain-outboxes-removal-restore-pull-model.

export { cleanupRetention } from './retention-cleanup.js';
