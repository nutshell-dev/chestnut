/**
 * DialogStore audit event names.
 *
 * Module-owned event namespace per H1 design (phase334 / r36 α 决策).
 * 字符串值与 phase148 起 events.ts 中央注册表的 SESSION_* 系列等价 / 0 漂移。
 */
export const DIALOG_AUDIT_EVENTS = {
  LOAD_FAILED: 'session_load_failed',
  SAVE_FAILED: 'session_save_failed',
  CORRUPTED: 'session_corrupted',
  CORRUPTED_ISOLATE_FAILED: 'session_corrupted_isolate_failed',
  RECOVERED: 'session_recovered',
  ARCHIVE_FAILED: 'session_archive_failed',
  ARCHIVE_READ_FAILED: 'session_archive_read_failed',
} as const;
