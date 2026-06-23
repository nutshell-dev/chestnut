/**
 * metrics-snapshot cron job audit events（业主自治、归 helper）。
 * 字符串值与 cron 命名空间起步态等价（phase 129 仅迁命名空间、不改 wire 格式）。
 */
export const METRICS_SNAPSHOT_AUDIT_EVENTS = {
  SNAPSHOT: 'cron_metrics_snapshot',
} as const;
