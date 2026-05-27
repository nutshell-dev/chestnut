/**
 * Viewport UI audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts VIEWPORT_ + CHAT_VIEWPORT_ 系列等价 / 0 漂移。
 */
export const VIEWPORT_AUDIT_EVENTS = {
  UI_CROSS_POLLUTION: 'viewport_ui_cross_pollution',
  EVENT_INGEST: 'viewport_event_ingest',
  RENDER_BATCH: 'viewport_render_batch',
  SPINNER_LIFECYCLE: 'viewport_spinner_lifecycle',
  SHUTDOWN: 'viewport_shutdown',
  WATCHER_FAILED: 'chat_viewport_watcher_failed',
  WATCHER_CALLBACK_FAILED: 'chat_viewport_watcher_callback_failed',
  UNKNOWN_EVENT: 'viewport_unknown_event',
  COMMAND_ERROR: 'viewport_command_error',
  CLAWSDIR_SCAN_FAILED: 'viewport_clawsdir_scan_failed',
  TASK_STREAM_STALE_CLEANUP: 'viewport_task_stream_stale_cleanup',
  INVALID_TASK_ID: 'chat_viewport_invalid_task_id',
  STREAM_READER_START_FAILED: 'chat_viewport_stream_reader_start_failed',
  HISTORY_REPLAY_FAILED: 'chat_viewport_history_replay_failed',
  REFRESH_CLAWS_FAILED: 'chat_viewport_refresh_claws_failed',
} as const;
