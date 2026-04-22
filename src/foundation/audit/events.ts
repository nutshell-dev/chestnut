/**
 * Phase 148 结构化事件通道 — L2 审计事件常量
 *
 * 命名规范：<module>_<action>_<outcome>
 * outcome 枚举详见 coding plan/phase148/Phase 148 Step 1 决策文档.md § Q4
 * （单一事实源，代码注释不维护重复清单）
 */

export const AUDIT_EVENTS = {
  // --- AuditLog 自身 ---
  // AuditWriter.write 失败不进 audit 流（递归边界，console.error 兜底）
  // 此处仅占位备忘，不导出事件名

  // --- SessionStore ---
  SESSION_LOAD_FAILED: 'session_load_failed',
  SESSION_SAVE_FAILED: 'session_save_failed',
  SESSION_CORRUPTED: 'session_corrupted',
  SESSION_CORRUPTED_ISOLATE_FAILED: 'session_corrupted_isolate_failed',
  SESSION_RECOVERED: 'session_recovered',
  SESSION_ARCHIVE_FAILED: 'session_archive_failed',
  SESSION_ARCHIVE_READ_FAILED: 'session_archive_read_failed',

  // --- Snapshot ---
  SNAPSHOT_INIT_FAILED: 'snapshot_init_failed',
  SNAPSHOT_INIT_CLEANUP_FAILED: 'snapshot_init_cleanup_failed',
  SNAPSHOT_COMMIT_FAILED: 'snapshot_commit_failed',
  SNAPSHOT_COMMITTED: 'snapshot_committed',
  SNAPSHOT_DEGRADED: 'snapshot_degraded',

  // --- FileWatcher ---
  WATCHER_CALLBACK_FAILED: 'watcher_callback_failed',
  WATCHER_READY_FAILED: 'watcher_ready_failed',
  WATCHER_FAILED: 'watcher_failed',

  // --- Stream ---
  STREAM_WRITE_DROPPED: 'stream_write_dropped',
  STREAM_APPEND_FAILED: 'stream_append_failed',
  STREAM_ARCHIVE_FAILED: 'stream_archive_failed',
  STREAM_ARCHIVE_PRUNE_FAILED: 'stream_archive_prune_failed',
  STREAM_READER_CALLBACK_FAILED: 'stream_reader_callback_failed',
  STREAM_READER_FILE_MISSING: 'stream_reader_file_missing',
  STREAM_READER_PARSE_FAILED: 'stream_reader_parse_failed',
  STREAM_READER_READ_FAILED: 'stream_reader_read_failed',
  STREAM_READER_UNLINKED: 'stream_reader_unlinked',
  STREAM_READER_WATCHER_FAILED: 'stream_reader_watcher_failed',

  /**
   * StreamReader 连续 parse_failed 越阈值升级为 corrupt（Design「不静默」硬化）。
   * 触发：
   *   - consecutive_fail：连续 ≥ CONSECUTIVE_PARSE_FAIL_LIMIT（5）次 parse_failed，或
   *   - ratio_high：近 RECENT_WINDOW（10）次读取里 parse_failed 占比 > 50%
   * 触发后 reader 写本事件 + active=false + 停 watcher（不再输出错乱事件）。
   * 载荷：path / consecutive / trigger(consecutive_fail|ratio_high) / recent_total / recent_fail
   */
  STREAM_READER_CORRUPT: 'stream_reader_corrupt',

  // --- Messaging ---
  INBOX_DONE: 'inbox_done',
  INBOX_WRITTEN: 'inbox_written',
  INBOX_FAILED: 'inbox_failed',
  INBOX_LIST_FAILED: 'inbox_list_failed',
  INBOX_MOVE_FAILED: 'inbox_move_failed',
  OUTBOX_SENT: 'outbox_sent',
  OUTBOX_SEND_FAILED: 'outbox_send_failed',

  // --- ProcessManager ---
  PROCESS_SPAWNED: 'process_spawned',
  PROCESS_SPAWN_FAILED: 'process_spawn_failed',
  PROCESS_STOPPED: 'process_stopped',
  PROCESS_STOP_FAILED: 'process_stop_failed',
  PROCESS_KILL_ESCALATED: 'process_kill_escalated',
  PROCESS_STOP_STALE: 'process_stop_stale',
  PID_READ_FAILED: 'pid_read_failed',
  PID_REMOVE_FAILED: 'pid_remove_failed',
  PID_EMPTY: 'pid_empty',
  ORPHAN_SIGTERM_FAILED: 'orphan_sigterm_failed',
  LOCKFILE_READ_FAILED: 'lockfile_read_failed',
  LOCKFILE_CLEANUP_FAILED: 'lockfile_cleanup_failed',
  LOCK_ACQUIRED: 'lock_acquired',
  LOCK_RELEASED: 'lock_released',
  PROCESS_LIST_FAILED: 'process_list_failed',

  // --- Viewport UI ---
  VIEWPORT_UI_CROSS_POLLUTION: 'viewport_ui_cross_pollution',

  /**
   * chat-viewport handleEvent 收到的 stream 事件批次聚合。
   * 触发：每 INGEST_BATCH_SIZE 事件或 INGEST_FLUSH_MS 毫秒（先到者）。
   * 载荷：batch_size / types（JSON histogram）/ span_ms（本批第一条到最后一条耗时）
   */
  VIEWPORT_EVENT_INGEST: 'viewport_event_ingest',

  /**
   * chat-viewport updateDisplay 渲染调用批次聚合。
   * 触发：每 RENDER_BATCH_SIZE 次或 RENDER_FLUSH_MS 毫秒。
   * 载荷：calls / total_ms / output_lines（最后一次的 outputLines 长度）/ suffix_lines
   */
  VIEWPORT_RENDER_BATCH: 'viewport_render_batch',

  /**
   * Spinner 启停（不聚合，每次写）。
   * 载荷：action(start|stop) / text / elapsed_ms（仅 stop 时）/ orphan=1（孤 stop：无前置 start）
   */
  VIEWPORT_SPINNER_LIFECYCLE: 'viewport_spinner_lifecycle',

  /**
   * chat-viewport 退出。cleanup / daemon dead 检测 / ESC 中断 / stream 结束统一走此事件。
   * 载荷：reason(daemon_dead|user_quit|stream_end)
   */
  VIEWPORT_SHUTDOWN: 'viewport_shutdown',

  // --- TaskSystem ---
  PENDING_INGEST_FAILED: 'pending_ingest_failed',
} as const;

export type AuditEventName = typeof AUDIT_EVENTS[keyof typeof AUDIT_EVENTS];
