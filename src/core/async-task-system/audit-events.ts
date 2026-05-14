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
  PENDING_WATCHER_FAILED: 'task_pending_watcher_failed',
  PENDING_WATCHER_CALLBACK_FAILED: 'task_pending_watcher_callback_failed',
  DISCARDED: 'task_discarded',
  RECOVERED: 'task_recovered',
  RECOVERY_COMPLETE: 'task_recovery_complete',
  RECOVERY_FAILED: 'task_recovery_failed',
  RECOVERY_DEAD_LETTER: 'task_recovery_dead_letter',
  START_FAILED: 'task_start_failed',
  STREAM_FAILED: 'task_stream_failed',
  HANDLER_FAILED: 'task_handler_failed',
  RESULT_WRITE_FAILED: 'task_result_write_failed',
  INBOX_WRITE_FAILED: 'task_inbox_write_failed',
  SHUTDOWN_TIMEOUT: 'task_shutdown_timeout',
  MOVE_FAILED: 'task_move_failed',
  CANCELLED: 'task_cancelled',
  TOOL_RETRY: 'tool_task_retry',
  SUBAGENT_WORKSPACE_CLEANUP_FAILED: 'subagent_workspace_cleanup_failed',
  SHUTDOWN_PENDING_CLEANUPS_DRAINED: 'task_shutdown_pending_cleanups_drained',
} as const;
