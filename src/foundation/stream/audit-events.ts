/**
 * Stream audit event names.
 *
 * Module-owned event namespace per H1 design (phase334 / r36 α 决策).
 * 字符串值与 phase148 起 events.ts 中央注册表的 STREAM_* 系列等价 / 0 漂移。
 */
export const STREAM_AUDIT_EVENTS = {
  WRITE_AFTER_CLOSE: 'stream_write_after_close',
  APPEND_FAILED: 'stream_append_failed',
  ARCHIVE_FAILED: 'stream_archive_failed',
  ARCHIVE_PRUNE_FAILED: 'stream_archive_prune_failed',
  WRITER_OPEN_CREATED_EMPTY: 'stream_writer_open_created_empty',
  WRITER_OPEN_PRESERVED_RACED: 'stream_writer_open_preserved_raced',
  READER_CALLBACK_FAILED: 'stream_reader_callback_failed',
  READER_FILE_MISSING: 'stream_reader_file_missing',
  READER_PARSE_FAILED: 'stream_reader_parse_failed',
  READER_READ_FAILED: 'stream_reader_read_failed',
  READER_UNLINKED: 'stream_reader_unlinked',
  READER_WATCHER_FAILED: 'stream_reader_watcher_failed',
  READER_WATCHER_CALLBACK_FAILED: 'stream_reader_watcher_callback_failed',
  READER_WATCHER_RESET: 'stream_reader_watcher_reset',
  READER_CORRUPT: 'stream_reader_corrupt',
  TRUNCATION_REPAIR_FAILED: 'stream_truncation_repair_failed',
  TRUNCATION_REPAIRED: 'stream_truncation_repaired',
} as const;


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 */
export const STREAM_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  stream_write_after_close: 'audit',
  stream_append_failed: 'audit',
  stream_archive_failed: 'audit',
  stream_archive_prune_failed: 'audit',
  stream_writer_open_created_empty: 'audit',
  stream_writer_open_preserved_raced: 'audit',
  stream_reader_callback_failed: 'audit',
  stream_reader_file_missing: 'audit',
  stream_reader_parse_failed: 'audit',
  stream_reader_read_failed: 'audit',
  stream_reader_unlinked: 'audit',
  stream_reader_watcher_failed: 'audit',
  stream_reader_watcher_callback_failed: 'audit',
  stream_reader_watcher_reset: 'audit',
  stream_reader_corrupt: 'audit',
  stream_truncation_repair_failed: 'audit',
  stream_truncation_repaired: 'audit',
} as const;
