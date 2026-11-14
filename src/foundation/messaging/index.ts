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
export { OutboxReader, createOutboxReader } from './outbox-reader.js';
// phase 1784: outbox peek typed outcome — empty 与 list/read/decode failure 可区分
export type { OutboxPeekResult, OutboxReaderOptions } from './outbox-reader.js';

export { InboxWriter, createInboxWriter } from './inbox-writer.js';
export type { InboxMessageOptionsBase } from './inbox-writer.js';

export { InboxReader } from './inbox-reader.js';
export type {
  InboxEntry,
  ScannedInboxLocation,
  InboxDeliveryBatch,
  InboxDeliverySession,
} from './inbox-reader.js';
// delivery batch typed outcome — claim/quarantine/move partial failure 不再压平为成功
export type { InboxDeliveryResult } from './inbox-reader.js';
// phase 1804: Messaging-owned pending cleanup（Daemon 不见目录/文件名/删除动作）
export type { CleanupPendingResult, InboxMaintenance } from './inbox-reader.js';
export { PendingViewError } from './inbox-reader.js';
export type {
  InboxHandle,
  OutboxClaimHandle,
  OutboxInitResult,
  OutboxListResult,
  OutboxMessage,
  InboxMessage,
  InboxPeekResult,
  Priority,
} from './types.js';
// phase 1781: init typed recovery outcome — runtime caller 显式处理 degraded
export type { InboxInitResult } from './types.js';
export { PRIORITY_ORDER } from './types.js';
export {
  InboxListFailed,
  InboxMoveFailed,
  OutboxClaimBindingError,
  OutboxMoveFailed,
  OutboxSettlementRequired,
} from './errors.js';

// Callers provide roots; leaf constants remain private to Messaging.
export { makeInboxTarget, initializeMessagingLayout } from './dirs.js';
export type { InboxTarget } from './dirs.js';

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
// phase 1820: messaging 自有 config schema（yaml `messaging.*` owner）+ writer limits capability
export {
  messagingConfigSchema,
  MESSAGING_BODY_MAX_BYTES_DEFAULT,
  MESSAGING_WRITER_LIMITS_DEFAULT,
  type MessagingWriterLimits,
} from './config-schema.js';

export { notifyInbox, notifyClaw, writeInboxAsync } from './notify.js';

// phase 1864 Step C（CT-D2）：cross-target claw 投递 adapter（Messaging own 发送；
// 目标位置由拓扑 owner 经 resolver 注入）。
export { createClawNotifier, clawNotifyPriority } from './claw-notify.js';
export type {
  ClawNotifier,
  ClawNotifierDeps,
  ClawNotifyIntent,
  ClawNotifyTarget,
  ClawNotifyTargetResolver,
} from './claw-notify.js';

export { createSendContentTracker, feedSendContentDelta } from './tools/send-content-extractor.js';
export { createSendTool } from './tools/send.js';

// phase 1476: drainOutboxes / Messaging / createMessaging 全砍。
// claw→motion 通信改 pull 模型（motion 见 claw_outbox_summary 索引 → CLI claw <id> outbox 拉取消费）。
// claw→claw 通信通道暂闭（claw 不知其他 claw 名字 / send tool to: 写死 motion）。
// 详 design/modules/l2_messaging.md §7.A A.phase1476-drain-outboxes-removal-restore-pull-model.
