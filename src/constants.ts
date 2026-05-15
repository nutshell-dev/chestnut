// ============================================================================
// ClawForum Internal Constants
// ============================================================================
// Centralized location for all magic numbers and internal constants.
// Organized by functional domain for maintainability.
// ============================================================================

// ----------------------------------------------------------------------------
// System Identities
// ----------------------------------------------------------------------------

/** Motion claw identifier - the root orchestrator claw */
export const MOTION_CLAW_ID = 'motion';

// ----------------------------------------------------------------------------
// File System Tools
// ----------------------------------------------------------------------------

/** Maximum lines to read in read tool */
export const READ_MAX_LINES = 200;

/** Maximum characters to read in read tool */
export const READ_MAX_CHARS = 8000;

/** Maximum entries to list in ls tool */
export const LS_MAX_ENTRIES = 100;

// ----------------------------------------------------------------------------
// Execution Tools
// ----------------------------------------------------------------------------

/** Truncation threshold for combined exec output (β 应用层 / 应然 §10.4 ~2000) */
export const EXEC_MAX_OUTPUT = 2000;

// ----------------------------------------------------------------------------
// Subagent System
// ----------------------------------------------------------------------------

/** Default timeout for subagent tasks (ms) - 5 minutes */
export const SUBAGENT_TIMEOUT_MS = 300000;

/**
 * DEFAULT_LLM_IDLE_TIMEOUT_MS phase 748 物理迁 src/foundation/llm-orchestrator/defaults.ts
 */

/**
 * Initial idle timeout written to user config by `init` command (ms)
 * - More lenient default for new users (vs schema 60s fallback)
 * - User can edit later to tighter value
 */
export const INIT_LLM_IDLE_TIMEOUT_MS = 120000;

// ----------------------------------------------------------------------------
// Communication
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Contract/State Management
// ----------------------------------------------------------------------------

/** Maximum retries for file lock acquisition */
export const LOCK_MAX_RETRIES = 20;

/** Delay between lock retry attempts (ms) */
export const LOCK_RETRY_DELAY_MS = 500;

/** Lock held longer than this is considered stale and force-cleared (ms) */
export const LOCK_STALE_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes

// ----------------------------------------------------------------------------
// LLM Integration
// ----------------------------------------------------------------------------

/** Token reserve for thinking budget calculation */
export const THINKING_TOKEN_RESERVE = 1024;

/** Default max tokens for LLM calls */
export const REACT_DEFAULT_MAX_TOKENS = 4096;

// ----------------------------------------------------------------------------
// Daemon / CLI
// ----------------------------------------------------------------------------

/** Interval for heartbeat health checks (ms) */
export const HEARTBEAT_CHECK_INTERVAL_MS = 5000;

/** Default fallback timeout for daemon operations (ms) */
export const DAEMON_FALLBACK_TIMEOUT_MS = 30000;

/** Delay after interrupt recovery before processing next message (ms) */
export const INTERRUPT_RECOVERY_DELAY_MS = 1000;

/** Cooldown between startup_check notifications to prevent spam from rapid daemon restarts (ms) — 10 minutes */
export const STARTUP_CHECK_COOLDOWN_MS = 10 * 60 * 1000;

// ----------------------------------------------------------------------------
// React Loop / Execution
// ----------------------------------------------------------------------------

/** Maximum consecutive parse errors before aborting */
export const MAX_CONSECUTIVE_PARSE_ERRORS = 3;

/** Maximum consecutive max_tokens tool_use before aborting */
export const MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE = 3;

// ----------------------------------------------------------------------------
// Task System
// ----------------------------------------------------------------------------

/** Default maximum concurrent tasks */
export const DEFAULT_MAX_CONCURRENT_TASKS = 3;

// ----------------------------------------------------------------------------
// UI / Display
// ----------------------------------------------------------------------------

/** Maximum characters for summary storage */
export const SUMMARY_MAX_CHARS = 500;

/** Maximum output lines cap for viewport */
export const OUTPUT_LINES_CAP = 5000;

// ----------------------------------------------------------------------------
// LLM Stream
// ----------------------------------------------------------------------------

/** Maximum duration for a single LLM stream call (ms) - 5 minutes */
export const STREAM_MAX_DURATION_MS = 5 * 60 * 1000;

// ----------------------------------------------------------------------------
// Gateway
// ----------------------------------------------------------------------------

/** Debounce window for interrupt messages from clients (ms) */
export const GATEWAY_INTERRUPT_DEBOUNCE_MS = 500;

/** Default timeout for ask_user tool waiting for client reply (ms) — 30 minutes */
export const GATEWAY_ASK_USER_TIMEOUT_MS = 30 * 60 * 1000;

// ----------------------------------------------------------------------------
// Contract
// ----------------------------------------------------------------------------

/** 契约脚本验收超时 (ms) */
export const CONTRACT_SCRIPT_TIMEOUT_MS = 60_000;

// ----------------------------------------------------------------------------
// LLM Provider Defaults
// ----------------------------------------------------------------------------

/** Default LLM API call timeout (ms) */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** Default circuit breaker reset timeout (ms) */
export const DEFAULT_RESET_TIMEOUT_MS = 60_000;

/** Default LLM retry delay between attempts (ms) */
export const DEFAULT_RETRY_DELAY_MS = 1_000;

/** Default LLM retry attempts before failing */
export const DEFAULT_LLM_RETRY_ATTEMPTS = 3;

// ----------------------------------------------------------------------------
// Tool / Runtime Defaults
// ----------------------------------------------------------------------------

/** Default tool execution timeout (ms) */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

// ----------------------------------------------------------------------------
// Watchdog Defaults
// ----------------------------------------------------------------------------

/** Watchdog liveness check interval (ms) */
export const WATCHDOG_INTERVAL_MS = 30_000;

/** Disk warning threshold (MB) */
export const DEFAULT_DISK_WARNING_MB = 500;

/** Claw inactivity timeout - kill claw if no activity (ms) — 5 minutes */
export const CLAW_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

// ----------------------------------------------------------------------------
// Cron Defaults
// ----------------------------------------------------------------------------

/** Cron tick interval (ms) */
export const CRON_TICK_INTERVAL_MS = 1_000;

// ----------------------------------------------------------------------------
// LLM Retry / Error Handling
// ----------------------------------------------------------------------------

/** Maximum retries for transient LLM failures in daemon loop */
export const LLM_MAX_RETRIES = 3;

/** Initial retry delay for LLM failures (ms) — doubles each retry up to max */
export const LLM_RETRY_INITIAL_DELAY_MS = 30_000;

/** Maximum retry delay for LLM failures (ms) — caps exponential backoff */
export const LLM_RETRY_MAX_DELAY_MS = 300_000;

// ----------------------------------------------------------------------------
// Truncation Limits (phase 740)
// ----------------------------------------------------------------------------

/** Short UUID prefix length for human-readable IDs (`randomUUID().slice(0, 8)` pattern) */
export const UUID_SHORT_LEN = 8;



