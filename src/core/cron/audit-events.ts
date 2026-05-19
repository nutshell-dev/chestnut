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
  PARSE_FALLBACK: 'cron_parse_fallback',
  JOB_ERROR: 'cron_job_error',
  HANDLER_TIMEOUT: 'cron_handler_timeout',
  HANDLER_STUCK: 'cron_handler_stuck',
  JOB_LATE_SETTLED: 'cron_job_late_settled',  // NEW phase 758
  RUNNER_DRAIN_TIMEOUT: 'cron_drain_timeout',   // phase 793 (P0.22): stop drain cap timeout
  RUNNER_DRAIN_LATE_SETTLE: 'cron_drain_late_settle',  // NEW phase 867 (r111 E fork): post-drain late settle observability
} as const;
