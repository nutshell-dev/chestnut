/**
 * retention-cleanup cron job audit events（业主自治、归 helper）。
 * 字符串值与 cron 命名空间起步态等价（phase 129 仅迁命名空间、不改 wire 格式）。
 */
export const RETENTION_CLEANUP_AUDIT_EVENTS = {
  CLEANUP: 'cron_retention_cleanup',
} as const;
