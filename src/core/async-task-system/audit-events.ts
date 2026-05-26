/**
 * AsyncTaskSystem audit event names.
 *
 * Module-owned event namespace per H1 design.
 * 字符串值 + 模块自治 const 集合 / 与起步态 events.ts TASK_ + PENDING_ + TOOL_TASK_ 系列等价 / 0 漂移。
 */
export const TASK_AUDIT_EVENTS = {
  TASK_SCHEDULED: 'task_scheduled',
  TASK_STARTED: 'task_started',
  TASK_COMPLETED: 'task_completed',
  PENDING_INGEST_FAILED: 'pending_ingest_failed',
  PENDING_QUEUE_OVERFLOW: 'task_pending_queue_overflow',
  PENDING_QUEUE_OVERFLOW_NOTIFIED: 'task_pending_queue_overflow_notified',
  PENDING_WATCHER_FAILED: 'task_pending_watcher_failed',
  PENDING_WATCHER_CALLBACK_FAILED: 'task_pending_watcher_callback_failed',
  DISCARDED: 'task_discarded',
  RECOVERED: 'task_recovered',
  RECOVERY_COMPLETE: 'task_recovery_complete',
  RECOVERY_FAILED: 'task_recovery_failed',
  RECOVERY_DEAD_LETTER: 'task_recovery_dead_letter',
  START_FAILED: 'task_start_failed',
  HANDLER_FAILED: 'task_handler_failed',
  RESULT_WRITE_FAILED: 'task_result_write_failed',
  INBOX_WRITE_FAILED: 'task_inbox_write_failed',
  SHUTDOWN_TIMEOUT: 'task_shutdown_timeout',
  MOVE_FAILED: 'task_move_failed',
  TASK_CANCEL_RACE_LOST_TO_DISPATCH: 'task_cancel_race_lost_to_dispatch',
  CANCELLED: 'task_cancelled',
  TOOL_RETRY: 'tool_task_retry',
  TOOL_ASYNC_RESULT: 'tool_async_result',                // ← NEW (phase 850 / r108 F fork F2.3)
  SHUTDOWN_PENDING_CLEANUPS_DRAINED: 'task_shutdown_pending_cleanups_drained',
  TASK_CORRUPT: 'task_corrupt',                            // ← NEW (phase 852 / r110 F fork)
  CANCEL_PROMISE_REJECTED: 'task_cancel_promise_rejected', // ← NEW (phase 859 / r111 H fork Sa.2)
  RESULT_DELIVERY_ENSURE_DIR_FAILED: 'result_delivery_ensure_dir_failed',  // ← NEW (phase 878 / B-β2)
  PARSE_FAILED: 'task_parse_failed', // ← NEW (phase 1013 / r123 E fork E.4)
  RESULT_DELIVERY_FAILED: 'task_result_delivery_failed', // ← NEW (phase 1069 / T3)
  LEGACY_PENDING_TASK_NO_MODE: 'legacy_pending_task_no_mode', // ← NEW (phase 1258 / F.2 sunset observability)
  RUNNING_FILE_DELETE_FAILED: 'task_running_file_delete_failed', // ← NEW (phase 1324 / r137 C fork F.hot.6)
  CLEANUP_RETENTION_DELETE_FAILED: 'task_cleanup_retention_delete_failed',
  TASK_SHUTDOWN_TIMEOUT_HIT: 'task_shutdown_timeout_hit', // ← NEW (phase 1332 / r138 C fork N4)
} as const;
