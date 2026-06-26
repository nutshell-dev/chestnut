/**
 * @module L4.ClawTopology.OutboxSummary
 * phase 134: audit events 命名空间业主自治（从 CRON_AUDIT_EVENTS 迁出）.
 * 字符串值不变（wire 格式稳定）.
 */

export const OUTBOX_SUMMARY_AUDIT_EVENTS = {
  OUTBOX_SUMMARY_WRITTEN: 'cron_outbox_summary_written',
  OUTBOX_SUMMARY_FAILED: 'cron_outbox_summary_failed',
} as const;

export type OutboxSummaryAuditEvent =
  typeof OUTBOX_SUMMARY_AUDIT_EVENTS[keyof typeof OUTBOX_SUMMARY_AUDIT_EVENTS];
