/**
 * Stream audit event names.
 *
 * Module-owned event namespace per H1 design (phase334 / r36 α 决策).
 * 字符串值与 phase148 起 events.ts 中央注册表的 STREAM_* 系列等价 / 0 漂移。
 */
export const STREAM_AUDIT_EVENTS = {
  WRITE_DROPPED: 'stream_write_dropped',
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
  READER_CORRUPT: 'stream_reader_corrupt',
} as const;
