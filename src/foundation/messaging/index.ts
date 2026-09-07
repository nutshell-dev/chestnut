/**
 * @module L2c.Messaging
 * Messaging module (L2)
 *
 * Inbox/outbox directory management, message delivery and retrieval.
 * Dependencies: FileSystem
 */

export { OutboxWriter } from './outbox-writer.js';

// phase 1243: Messaging 自家 inbox message type declarations
export { MESSAGING_INBOX_MESSAGE_TYPES } from './inbox-formatters.js';

// phase 42: outbox 读侧（业主入口、用于聚合查询如 outbox-summary 未读计数）
export { OutboxReader } from './outbox-reader.js';

export { InboxWriter, makeInboxPath } from './inbox-writer.js';
export type { InboxMessageOptionsBase } from './inbox-writer.js';

export { InboxReader } from './inbox-reader.js';
export type {
  InboxEntry,
  ScannedInboxLocation,
  InboxDeliveryBatch,
  InboxDeliverySession,
} from './inbox-reader.js';
export { PendingViewError } from './inbox-reader.js';
export type { InboxHandle, OutboxMessage, InboxMessage, Priority } from './types.js';
export { PRIORITY_ORDER } from './types.js';
export { InboxListFailed, InboxMoveFailed } from './errors.js';

// phase 1423 F4: dirs path const re-export — 跨模块 (daemon / core) 路径合成走 barrel。
// phase 1780: INBOX_INFLIGHT_DIR / INBOX_MISROUTED_DIR 补 barrel（owner 常量单源）。
// sister L2 foundation/paths.ts 内部 sister 保留 deep import (depcruise rule allowlist)。
export {
  INBOX_PENDING_DIR,
  INBOX_INFLIGHT_DIR,
  INBOX_MISROUTED_DIR,
  INBOX_DONE_DIR,
  INBOX_FAILED_DIR,
  OUTBOX_PENDING_DIR,
  OUTBOX_DONE_DIR,
  OUTBOX_FAILED_DIR,
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

// phase 1243: inbox 消息 rendering 声明协议
export {
  createInboxMessageTypeRegistry,
  renderStandardInboxMessage,
  registerInboxMessageTypes,
} from './formatter-registry.js';


// phase 743: parseFrontmatterFrame barrel 导出，SkillSystem 等消费者不再 deep import
export { parseFrontmatterFrame } from './frontmatter-frame.js';
// phase 1777 Step C: EventLoop quota gate 判 pending 新 user 消息（from/timestamp 读 meta）
export { decodeInbox } from './codec-inbox.js';
export type {
  MessageFormatter,
  InboxMessageRenderingResolver,
  InboxMessageTypeRegistry,
  InboxMessageTypeDeclaration,
} from './formatter-registry.js';

export { createInboxReader } from './inbox-reader.js';
export { createOutboxWriter } from './outbox-writer.js';

export { notifyInbox, notifyClaw, writeInboxAsync } from './notify.js';

export { createSendContentTracker, feedSendContentDelta } from './tools/send-content-extractor.js';
export { createSendTool } from './tools/send.js';

// phase 1476: drainOutboxes / Messaging / createMessaging 全砍。
// claw→motion 通信改 pull 模型（motion 见 claw_outbox_summary 索引 → CLI claw <id> outbox 拉取消费）。
// claw→claw 通信通道暂闭（claw 不知其他 claw 名字 / send tool to: 写死 motion）。
// 详 design/modules/l2_messaging.md §7.A A.phase1476-drain-outboxes-removal-restore-pull-model.
