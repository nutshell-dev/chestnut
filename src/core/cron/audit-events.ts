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
  PARSE_FALLBACK: 'cron_parse_fallback',
  JOB_ERROR: 'cron_job_error',
} as const;
