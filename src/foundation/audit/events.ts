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
  PID_READ_OK: 'pid_read_ok',
  PID_READ_FAILED: 'pid_read_failed',
  PID_WRITE_OK: 'pid_write_ok',
  PID_WRITE_FAILED: 'pid_write_failed',
  PID_REMOVE_OK: 'pid_remove_ok',
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

  // --- TaskSystem （phase248 B.2 sub-phase 2 补齐）---
  TASK_DISCARDED: 'task_discarded',
  TASK_RECOVERED: 'task_recovered',
  TASK_RECOVERY_COMPLETE: 'task_recovery_complete',
  TASK_RECOVERY_FAILED: 'task_recovery_failed',
  TASK_START_FAILED: 'task_start_failed',
  TASK_STREAM_FAILED: 'task_stream_failed',
  TASK_HANDLER_FAILED: 'task_handler_failed',
  TASK_RESULT_WRITE_FAILED: 'task_result_write_failed',
  TASK_INBOX_WRITE_FAILED: 'task_inbox_write_failed',
  TASK_SHUTDOWN_TIMEOUT: 'task_shutdown_timeout',
  TASK_MOVE_FAILED: 'task_move_failed',
  TASK_CANCELLED: 'task_cancelled',
  TOOL_TASK_RETRY: 'tool_task_retry',

  // --- Contract ---
  CONTRACT_LOCK_CLEARED: 'contract_lock_cleared',
  CONTRACT_LOCK_UNLINK_FAILED: 'contract_lock_unlink_failed',
  CONTRACT_PROGRESS_CORRUPTED: 'contract_progress_corrupted',
  CONTRACT_ARCHIVE_STARTED: 'contract_archive_started',
  CONTRACT_ROLLBACK_FAILED: 'contract_rollback_failed',
  CONTRACT_CREATED: 'contract_created',
  CONTRACT_ACCEPTANCE_STARTED: 'contract_acceptance_started',
  CONTRACT_UPDATED: 'contract_updated',
  CONTRACT_NOTIFY_FAILED: 'contract_notify_failed',
  CONTRACT_MOVE_ARCHIVE_FAILED: 'contract_move_archive_failed',
  CONTRACT_ACCEPTANCE_INBOX_FAILED: 'contract_acceptance_inbox_failed',
  CONTRACT_ACCEPTANCE_RESET_FAILED: 'contract_acceptance_reset_failed',
  CONTRACT_ACCEPTANCE_SCRIPT_STARTED: 'contract_acceptance_script_started',
  CONTRACT_RETRO_INDEX_FAILED: 'contract_retro_index_failed',
  CONTRACT_RETRO_YAML_FAILED: 'contract_retro_yaml_failed',
  CONTRACT_RETRO_SKILL_FAILED: 'contract_retro_skill_failed',
  CONTRACT_RETRO_MINING_FAILED: 'contract_retro_mining_failed',
  CONTRACT_RETRO_SCHEDULE_FAILED: 'contract_retro_schedule_failed',
  CONTRACT_RETRO_CLEANUP_FAILED: 'contract_retro_cleanup_failed',

  // --- Cron Jobs (Phase 227) ---
  CRON_DEEP_DREAM_JOB: 'cron_deep_dream_job',
  CRON_DEEP_DREAM_ERROR: 'cron_deep_dream_error',
  CRON_DISK_MONITOR_CHECK: 'cron_disk_monitor_check',
  CRON_DISK_MONITOR_THRESHOLD_EXCEEDED: 'cron_disk_monitor_threshold_exceeded',
  CRON_LLM_STATS: 'cron_llm_stats',
  CRON_RANDOM_DREAM_JOB: 'cron_random_dream_job',
  CRON_RANDOM_DREAM_WARNING: 'cron_random_dream_warning',

  // --- Cron Runner Lifecycle (Phase 232) ---
  CRON_RUNNER_STARTED: 'cron_runner_started',
  CRON_RUNNER_STOPPED: 'cron_runner_stopped',

  // --- Watchdog ---
  WATCHDOG_CLEANUP_FAILED: 'watchdog_cleanup_failed',
  WATCHDOG_CRASH: 'watchdog_crash',
  WATCHDOG_CLAW_SCAN: 'watchdog_claw_scan',
  CLAW_CRASH_DETECTED: 'claw_crash_detected',
  CLAW_CRASH_NOTIFY_DROPPED: 'claw_crash_notify_dropped',

  // --- Heartbeat ---
  HEARTBEAT_FIRE_FAILED: 'heartbeat_fire_failed',

  // --- SubAgent ---
  SUBAGENT_STEP_COMPLETE_FAILED: 'subagent_step_complete_failed',
  SUBAGENT_PERSIST_FAILED: 'subagent_persist_failed',
  SUBAGENT_LOG_APPEND_FAILED: 'subagent_log_append_failed',

  // --- Dispatch ---
  DISPATCH_LOAD_SKILLS_FAILED: 'dispatch_load_skills_failed',
  DISPATCH_CONTRACT_DONE_NOT_FOUND: 'dispatch_contract_done_not_found',
  DISPATCH_CONTRACT_DONE_PARSE_FAILED: 'dispatch_contract_done_parse_failed',
  DISPATCH_CONTRACT_DONE_MISSING_FIELDS: 'dispatch_contract_done_missing_fields',
  DISPATCH_WRITE_BY_CONTRACT_FAILED: 'dispatch_write_by_contract_failed',
  DISPATCH_NO_DIALOG_CONTEXT: 'dispatch_no_dialog_context',

  // --- Status ---
  STATUS_CONTRACT_ERROR: 'status_contract_error',
  STATUS_TASK_PENDING_ERROR: 'status_task_pending_error',
  STATUS_TASK_RUNNING_ERROR: 'status_task_running_error',

  // --- Runtime ---
  RUNTIME_PROCESS_BATCH_FAILED: 'runtime_process_batch_failed',

  // --- LLM Service (Phase 254) ---
  LLM_PROVIDER_ATTEMPT_FAILED: 'llm_provider_attempt_failed',
  LLM_RETRY_SCHEDULED: 'llm_retry_scheduled',
  LLM_PROVIDER_EXHAUSTED: 'llm_provider_exhausted',
  LLM_FALLBACK_SWITCHED: 'llm_fallback_switched',
  LLM_BREAKER_OPENED: 'llm_breaker_opened',
  LLM_BREAKER_HALF_OPEN: 'llm_breaker_half_open',
  LLM_BREAKER_CLOSED: 'llm_breaker_closed',
  LLM_HEALTHCHECK_FAILED: 'llm_healthcheck_failed',
  LLM_STREAM_RESET: 'llm_stream_reset',
  LLM_STREAM_PARSE_ERROR: 'llm_stream_parse_error',
  LLM_IDLE_FAILOVER_TRIGGERED: 'llm_idle_failover_triggered',

  // --- Gateway (Phase 256) ---
  GATEWAY_STARTED: 'gateway_started',
  GATEWAY_STOPPED: 'gateway_stopped',
  GATEWAY_ASK_USER_PENDING: 'gateway_ask_user_pending',
  GATEWAY_ASK_USER_RESOLVED: 'gateway_ask_user_resolved',
  GATEWAY_ASK_USER_CANCELLED: 'gateway_ask_user_cancelled',
  GATEWAY_ASK_USER_REPLY_DROPPED: 'gateway_ask_user_reply_dropped',
  GATEWAY_CONNECTION_DROPPED: 'gateway_connection_dropped',
  GATEWAY_INTERRUPT_TRIGGERED: 'gateway_interrupt_triggered',
  GATEWAY_INTERRUPT_DEBOUNCED: 'gateway_interrupt_debounced',
  GATEWAY_TRANSPORT_ERROR: 'gateway_transport_error',
} as const;

export type AuditEventName = typeof AUDIT_EVENTS[keyof typeof AUDIT_EVENTS];
