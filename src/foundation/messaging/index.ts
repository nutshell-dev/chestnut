/**
 * @module L2c.Messaging
 * Messaging module (L2)
 *
 * Inbox/outbox directory management, message delivery and retrieval.
 * Dependencies: FileSystem
 */

// phase 128 M#8 ratify: makeOutboxPath production cross-module 0 caller、tests/assembly/ 5 file use only
// 保留 export 维持 test reachability、若未来 src 无 caller 浮出 0 增加可降为 deep import
export { OutboxWriter, makeOutboxPath } from './outbox-writer.js';

// phase 42: outbox 读侧（业主入口、用于聚合查询如 outbox-summary 未读计数）
export { OutboxReader } from './outbox-reader.js';

export { InboxWriter, makeInboxPath } from './inbox-writer.js';
export type { InboxMessageOptionsBase } from './inbox-writer.js';

export { InboxReader } from './inbox-reader.js';
export type { InboxEntry, ScannedInboxLocation } from './inbox-reader.js';
export type { InboxHandle, OutboxMessage, InboxMessage, Priority, HeartbeatEntry } from './types.js';
export { PRIORITY_VALUES } from './types.js';
export { InboxListFailed, InboxMoveFailed } from './errors.js';

// phase 1423 F4: dirs path const re-export — 跨模块 (daemon / core) 路径合成走 barrel。
// sister L2 foundation/paths.ts 内部 sister 保留 deep import (depcruise rule allowlist)。
export {
  INBOX_PENDING_DIR,
  INBOX_DONE_DIR,
  INBOX_FAILED_DIR,
  INBOX_INFLIGHT_DIR,
  OUTBOX_PENDING_DIR,
  OUTBOX_DONE_DIR,
  OUTBOX_FAILED_DIR,
  OUTBOX_PROCESSING_DIR,
} from './dirs.js';

import { resolveDlqDir } from './dirs.js';
export { resolveDlqDir };

// phase 746: lightweight standalone query helpers (0-instance-dep)
export {
  peekPendingCount,
  peekPendingFilenames,
  listOutboxPendingSync,
} from './lightweight-query.js';

// phase 1435 F8: audit events const re-export — 跨模块 (cli / daemon) 引用走 barrel。
export { MESSAGING_AUDIT_EVENTS, MESSAGING_FILE_ROUTING } from './audit-events.js';

// phase 1414: inbox 消息格式化协议（散到各业主自管）
export { createMessageFormatterRegistry } from './formatter-registry.js';

// phase 436: system/user 消息识别 helper
export {
  SYSTEM_MESSAGE_PREFIX,
  isSystemMessage,
  isUserMessage,
} from './system-message-helper.js';

// phase 743: parseFrontmatterFrame barrel 导出，SkillSystem 等消费者不再 deep import
export { parseFrontmatterFrame } from './frontmatter-frame.js';
export type {
  MessageFormatter,
  MessageFormatterRegistry,
} from './formatter-registry.js';
// phase 128 M#8 ratify: formatUserInboxMessage production cross-module 0 caller、tests/assembly/ 5 file use only
export {
  formatUserInboxMessage,
  registerMessagingFormatters,
} from './inbox-formatters.js';

import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import { InboxReader } from './inbox-reader.js';
import type { ClawId } from '../claw-identity/index.js';
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
    `${baseDir}/misrouted`,  // phase 442
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


export { notifyInbox, notifyClaw, writeInboxAsync } from './notify.js';


// phase 1476: drainOutboxes / Messaging / createMessaging 全砍。
// claw→motion 通信改 pull 模型（motion 见 claw_outbox_summary 索引 → CLI claw <id> outbox 拉取消费）。
// claw→claw 通信通道暂闭（claw 不知其他 claw 名字 / send tool to: 写死 motion）。
// 详 design/modules/l2_messaging.md §7.A A.phase1476-drain-outboxes-removal-restore-pull-model.

