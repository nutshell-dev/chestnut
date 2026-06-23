/**
 * audit-size-monitor cron job audit events（业主自治、归 helper）。
 * 字符串值与 cron 命名空间起步态等价（phase 129 仅迁命名空间、不改 wire 格式）。
 */
export const AUDIT_SIZE_MONITOR_AUDIT_EVENTS = {
  THRESHOLD_EXCEEDED: 'cron_audit_size_threshold_exceeded',
  CHECK_FAILED: 'cron_audit_size_check_failed',
} as const;
