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
  INBOX_FAILED: 'inbox_failed',
  INBOX_WATCHER_FAILED: 'inbox_watcher_failed',
  INBOX_WATCHER_CALLBACK_FAILED: 'inbox_watcher_callback_failed',
  INBOX_LIST_FAILED: 'inbox_list_failed',
  INBOX_MOVE_FAILED: 'inbox_move_failed',
  INBOX_META_FAILED: 'inbox_meta_failed',
  INBOX_PEEK_RACE_SKIP: 'inbox_peek_race_skip',
  INBOX_PRIORITY_UNKNOWN: 'inbox_priority_unknown',
  INBOX_DEDUPED: 'inbox_deduped',
  OUTBOX_SENT: 'outbox_sent',
  OUTBOX_DELIVERED: 'outbox_delivered',
  OUTBOX_SEND_FAILED: 'outbox_send_failed',
  NOTIFY_CLAW_SENT: 'notify_claw_sent',
  NOTIFY_CLAW_FAILED: 'notify_claw_failed',
} as const;
