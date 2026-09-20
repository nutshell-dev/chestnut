/**
 * Messaging audit event names.
 *
 * Module-owned event namespace per H1 design (phase334 / r36 α 决策).
 * 字符串值与 phase148 起 events.ts 中央注册表的 INBOX_* / OUTBOX_* 系列等价 / 0 漂移。
 *
 * 注意：Messaging 模块含 INBOX + OUTBOX 双子命名空间 / INBOX prefix 保留
 * （模块内部需要区分 inbox vs outbox 两个 sub-resource）。
 */
export const MESSAGING_AUDIT_EVENTS = {
  INBOX_DONE: 'inbox_done',
  INBOX_WRITTEN: 'inbox_written',
  INBOX_WRITE_FAILED: 'inbox_write_failed',
  // phase 1869 Step D: 写入已提交（rename 后）但目录耐久性降级
  // （committed_platform_limited / committed_durability_unknown）——留证不静默。
  INBOX_WRITE_DURABILITY_DEGRADED: 'inbox_write_durability_degraded',
  INBOX_FAILED: 'inbox_failed',
  INBOX_WATCHER_FAILED: 'inbox_watcher_failed',
  INBOX_WATCHER_CALLBACK_FAILED: 'inbox_watcher_callback_failed',
  INBOX_LIST_FAILED: 'inbox_list_failed',
  INBOX_MOVE_FAILED: 'inbox_move_failed',
  INBOX_META_FAILED: 'inbox_meta_failed',
  INBOX_PEEK_RACE_SKIP: 'inbox_peek_race_skip',
  INBOX_PRIORITY_UNKNOWN: 'inbox_priority_unknown',
  INBOX_LEGACY_CLAW_ID_FIELD: 'inbox_legacy_claw_id_field',
  INBOX_DEDUPED: 'inbox_deduped',
  INBOX_PENDING_SOURCE_CLEANUP_FAILED: 'inbox_pending_source_cleanup_failed',
  INBOX_MARK_DONE_FAILED: 'inbox_mark_done_failed',
  INBOX_RECONCILE: 'inbox_reconcile',
  INBOX_NACK: 'inbox_nack',
  // phase 1020: inbox restore to pending 时发现同名不同内容 → stage 入 failed/DLQ
  INBOX_RESTORE_CONFLICT: 'inbox_restore_conflict',
  // phase 1034: 旧版 .tmp_<uuid>_<original>.md stage 文件无法可靠解析原文件名 → 移入 failed/ 隔离审计
  INBOX_STAGE_QUARANTINE: 'inbox_stage_quarantine',
  // phase 442 (review N3-C-H1 / R2-C-N1): unaddressed inbox 文件移到 misrouted/ 隔离
  INBOX_MISROUTED: 'inbox_misrouted',
  // phase 429 Step A (review medium): inbox body 超 cap、防 disk DoS / runaway bug
  INBOX_BODY_OVERSIZE: 'inbox_body_oversize',
  OUTBOX_SENT: 'outbox_sent',
  OUTBOX_DELIVERED: 'outbox_delivered',
  // phase 1748: outbox-skip 不读内容归档、独立审计（区别于 delivered）
  OUTBOX_SKIPPED: 'outbox_skipped',
  OUTBOX_SEND_FAILED: 'outbox_send_failed',
  // phase 430 Step E (review medium、inbox cap 对称): outbox body 超 cap、防 disk DoS
  OUTBOX_BODY_OVERSIZE: 'outbox_body_oversize',
  NOTIFY_CLAW_SENT: 'notify_claw_sent',
  NOTIFY_CLAW_FAILED: 'notify_claw_failed',
  NOTIFY_CLAW_HINT_FAILED: 'notify_claw_hint_failed',
  OUTBOX_PROCESSING_ORPHAN_CLEANED: 'outbox_processing_orphan_cleaned',
  OUTBOX_CLAIM_FAILED: 'outbox_claim_failed',
  OUTBOX_LIST_FAILED: 'outbox_list_failed',
  OUTBOX_PEEK_FAILED: 'messaging_outbox_peek_failed',
  UNKNOWN_DESTINATION_DLQ: 'messaging_unknown_destination_dlq',
  UNKNOWN_DESTINATION_REJECTED: 'messaging_unknown_destination_rejected',
  MESSAGING_MESSAGE_INVARIANT_VIOLATED: 'messaging_message_invariant_violated',
} as const;

/** phase 1821 Step B: Messaging audit event 值联合（routing key 类型单源）。 */
export type MessagingAuditEvent = (typeof MESSAGING_AUDIT_EVENTS)[keyof typeof MESSAGING_AUDIT_EVENTS];


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 *
 * phase 1821 Step B（audit-routing-catalog-drift）：key 收紧为
 * MessagingAuditEvent——漏配（新增事件未补 routing）与幽灵 key（routing 引用
 * 不存在的事件）均为编译期错误；双向 parity 运行时锚定见
 * tests/foundation/arch/messaging-audit-routing-parity.test.ts。
 * 顺带补漏：inbox_pending_source_cleanup_failed（事件在、routing 缺）。
 */
export const MESSAGING_FILE_ROUTING: Readonly<Record<MessagingAuditEvent, 'audit'>> = {
  inbox_done: 'audit',
  inbox_written: 'audit',
  inbox_write_failed: 'audit',
  inbox_write_durability_degraded: 'audit',
  inbox_failed: 'audit',
  inbox_watcher_failed: 'audit',
  inbox_watcher_callback_failed: 'audit',
  inbox_list_failed: 'audit',
  inbox_move_failed: 'audit',
  inbox_meta_failed: 'audit',
  inbox_peek_race_skip: 'audit',
  inbox_priority_unknown: 'audit',
  inbox_legacy_claw_id_field: 'audit',
  inbox_deduped: 'audit',
  inbox_pending_source_cleanup_failed: 'audit',
  inbox_mark_done_failed: 'audit',
  inbox_reconcile: 'audit',
  inbox_nack: 'audit',
  inbox_restore_conflict: 'audit',
  inbox_stage_quarantine: 'audit',
  inbox_misrouted: 'audit',
  inbox_body_oversize: 'audit',
  outbox_sent: 'audit',
  outbox_delivered: 'audit',
  outbox_skipped: 'audit',
  outbox_send_failed: 'audit',
  outbox_body_oversize: 'audit',
  notify_claw_sent: 'audit',
  notify_claw_failed: 'audit',
  notify_claw_hint_failed: 'audit',
  outbox_processing_orphan_cleaned: 'audit',
  outbox_claim_failed: 'audit',
  outbox_list_failed: 'audit',
  messaging_outbox_peek_failed: 'audit',
  messaging_unknown_destination_dlq: 'audit',
  messaging_unknown_destination_rejected: 'audit',
  messaging_message_invariant_violated: 'audit',
} as const;
