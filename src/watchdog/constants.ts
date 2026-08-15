/** Watchdog liveness check interval (ms) */
export const WATCHDOG_INTERVAL_MS = 30_000;

/** Disk warning threshold (MB) */
export const DEFAULT_DISK_WARNING_MB = 500;

/** Claw inactivity timeout - kill claw if no activity (ms) — 5 minutes */
export const CLAW_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

/** Watchdog log file path (relative to chestnut root) */
export const WATCHDOG_LOG = 'logs/watchdog.log';
