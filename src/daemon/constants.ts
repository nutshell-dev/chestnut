/** Default fallback timeout for daemon operations (ms) */
export const DAEMON_FALLBACK_TIMEOUT_MS = 30000;

/** Delay after interrupt recovery before processing next message (ms) */
export const INTERRUPT_RECOVERY_DELAY_MS = 1000;

/** Cooldown between startup_check notifications to prevent spam from rapid daemon restarts (ms) — 10 minutes */
export const STARTUP_CHECK_COOLDOWN_MS = 10 * 60 * 1000;

/** Maximum retries for transient LLM failures in daemon loop */
export const LLM_MAX_RETRIES = 3;

/** Initial retry delay for LLM failures (ms) — doubles each retry up to max */
export const LLM_RETRY_INITIAL_DELAY_MS = 30_000;

/** Maximum retry delay for LLM failures (ms) — caps exponential backoff */
export const LLM_RETRY_MAX_DELAY_MS = 300_000;
