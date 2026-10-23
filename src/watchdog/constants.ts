/** Watchdog liveness check interval (ms) */
export const WATCHDOG_INTERVAL_MS = 30_000;

// Phase 1974 Step C: HEARTBEAT_STALE_TIMEOUT_MS 随 executor recovery 退役——
// alive-but-loop-stale 阈值迁 `cron.jobs.executor_supervisor.heartbeat_stale_timeout_ms`。

