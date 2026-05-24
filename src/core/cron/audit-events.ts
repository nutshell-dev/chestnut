/**
 * Cron module audit event names (runner + jobs).
 *
 * Module-owned event namespace per H1 design (phase345 / B.p336-1 治理).
 * 字符串值与起步态等价 / 0 漂移。
 *
 * 多子资源（runner + jobs / llm_stats + disk_monitor）保留 prefix。
 */
export const CRON_AUDIT_EVENTS = {
  RUNNER_STARTED: 'cron_runner_started',
  RUNNER_STOPPED: 'cron_runner_stopped',
  LLM_STATS: 'cron_llm_stats',
  DISK_MONITOR_CHECK: 'cron_disk_monitor_check',
  DISK_MONITOR_THRESHOLD_EXCEEDED: 'cron_disk_monitor_threshold_exceeded',
  METRICS_SNAPSHOT: 'cron_metrics_snapshot',
  GIT_GC_WEEKLY: 'cron_git_gc_weekly',
  PARSE_INVALID: 'cron_parse_invalid',
  PARSE_FALLBACK: 'cron_parse_fallback',
  JOB_ERROR: 'cron_job_error',
  JOB_STARTED: 'cron_job_started',        // NEW phase1108: tick dispatch
  HANDLER_TIMEOUT: 'cron_handler_timeout',
  HANDLER_STUCK: 'cron_handler_stuck',
  JOB_LATE_SETTLED: 'cron_job_late_settled',  // NEW phase 758
  RUNNER_DRAIN_TIMEOUT: 'cron_drain_timeout',   // phase 793 (P0.22): stop drain cap timeout
  RUNNER_DRAIN_LATE_SETTLE: 'cron_drain_late_settle',  // NEW phase 867 (r111 E fork): post-drain late settle observability
  RETENTION_CLEANUP: 'cron_retention_cleanup',          // NEW phase 1053 β-1: retention cleanup cron
  RETENTION_CLEANUP_DELETE_FAILED: 'cron_retention_cleanup_delete_failed', // NEW phase1059
  AUDIT_SIZE_THRESHOLD_EXCEEDED: 'cron_audit_size_threshold_exceeded',     // NEW phase 1154 α-3b
  AUDIT_SIZE_CHECK_FAILED: 'cron_audit_size_check_failed',                 // NEW phase 1154 α-3b
  OUTBOX_DRAIN_START: 'cron_outbox_drain_start',                           // NEW phase 1160 P0-2
  OUTBOX_DRAIN_DONE: 'cron_outbox_drain_done',                             // NEW phase 1160 P0-2
  OUTBOX_DRAIN_FAILED: 'cron_outbox_drain_failed',                         // NEW phase 1210
  OUTBOX_DRAIN_RACE_LOST: 'cron_outbox_drain_race_lost',                   // NEW phase 1222 α-2: atomic claim loser
  STATE_SAVE_FAILED: 'cron_state_save_failed',                             // NEW phase 1210
} as const;
