/**
 * Memory module audit event names (deep dream + random dream).
 *
 * Module-owned event namespace per H1 design (phase345 / B.p336-1 治理).
 * 字符串值与起步态等价（'cron_*_dream_*'）/ 0 漂移。
 *
 * 注：字符串值保留 'cron_' 前缀（语义上 cron 调度的 dream 任务 / 历史命名 / 不改字符串）。
 */
export const MEMORY_AUDIT_EVENTS = {
  DEEP_DREAM_JOB: 'cron_deep_dream_job',
  DEEP_DREAM_ERROR: 'cron_deep_dream_error',
  DEEP_DREAM_CALL_FAILED: 'deep_dream_call_failed',
  DEEP_DREAM_UNEXPECTED: 'deep_dream_unexpected',
  RANDOM_DREAM_JOB: 'cron_random_dream_job',
  RANDOM_DREAM_WARNING: 'cron_random_dream_warning',
  RANDOM_DREAM_ERROR: 'cron_random_dream_error',   // ← NEW (phase 597)
  RANDOM_DREAM_PULSE: 'cron_random_dream_pulse',   // phase 633 ⚓11 / per-pulse audit / opt-in via pulseAuditEnabled
  RANDOM_DREAM_WAIT_TIMEOUT: 'random_dream_wait_timeout',
  RANDOM_DREAM_SUBAGENT_TIMEOUT: 'random_dream_subagent_timeout',
  RANDOM_DREAM_OUTPUT_MISSING: 'random_dream_output_missing',
  DREAM_OUTPUT_PERSISTED: 'dream_output_persisted',  // NEW phase 756
  DEEP_DREAM_RETRY_EXHAUSTED: 'deep_dream_retry_exhausted',  // NEW phase 1200
  RANDOM_DREAM_LATE_SETTLE_PENDING: 'memory_random_dream_late_settle_pending',   // NEW phase 170
  RANDOM_DREAM_LATE_SETTLE_CONSUMED: 'memory_random_dream_late_settle_consumed',  // NEW phase 170
  RANDOM_DREAM_LATE_SETTLE_ABANDONED: 'memory_random_dream_late_settle_abandoned', // NEW phase 170
} as const;


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 */
export const MEMORY_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  cron_deep_dream_job: 'audit',
  cron_deep_dream_error: 'audit',
  deep_dream_call_failed: 'audit',
  deep_dream_unexpected: 'audit',
  cron_random_dream_job: 'audit',
  cron_random_dream_warning: 'audit',
  cron_random_dream_error: 'audit',
  cron_random_dream_pulse: 'audit',
  random_dream_wait_timeout: 'audit',
  random_dream_subagent_timeout: 'audit',
  random_dream_output_missing: 'audit',
  dream_output_persisted: 'audit',
  deep_dream_retry_exhausted: 'audit',
  memory_random_dream_late_settle_pending: 'audit',
  memory_random_dream_late_settle_consumed: 'audit',
  memory_random_dream_late_settle_abandoned: 'audit',
} as const;
