/**
 * Phase 148 结构化事件通道 — L2 审计事件常量
 *
 * 命名规范：<module>_<action>_<outcome>
 * outcome 枚举详见 coding plan/phase148/Phase 148 Step 1 决策文档.md § Q4
 * （单一事实源，代码注释不维护重复清单）
 *
 * Phase 334 (r37 B): L1+L2 batch (SessionStore/Snapshot/Stream/Messaging/ProcessManager + AuditLog 占位)
 * 已迁出到各模块 audit-events.ts。
 *
 * Phase 338 (r38 B): L3+L4 batch (Viewport UI/TaskSystem/Contract/SubAgent/Dispatch/Status/Heartbeat/Gateway)
 * 已迁出。phase336 续 L5+L6 (Cron/Watchdog/LLM Response/LLM Service/Runtime)。
 */

export const AUDIT_EVENTS = {
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
  WATCHDOG_STATE_LOAD_FAILED: 'watchdog_state_load_failed',

  // --- Runtime ---
  RUNTIME_PROCESS_BATCH_FAILED: 'runtime_process_batch_failed',

  // --- LLM Response anomalies ---
  LLM_EMPTY_RESPONSE: 'llm_empty_response',
  LLM_UNKNOWN_STOP_REASON: 'llm_unknown_stop_reason',

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
} as const;

export type AuditEventName = typeof AUDIT_EVENTS[keyof typeof AUDIT_EVENTS];
