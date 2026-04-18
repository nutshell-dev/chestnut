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
// Process Management
// ----------------------------------------------------------------------------

/** Max time to wait for process spawn confirmation (ms) — polls every 50ms */
export const PROCESS_SPAWN_CONFIRM_MS = 3000;

/** Grace period for SIGTERM before SIGKILL (ms) */
export const SIGTERM_GRACE_MS = 5000;

// ----------------------------------------------------------------------------
// File System Tools
// ----------------------------------------------------------------------------

/** Maximum lines to read in read tool */
export const READ_MAX_LINES = 200;

/** Maximum characters to read in read tool */
export const READ_MAX_CHARS = 8000;

/** Maximum entries to list in ls tool */
export const LS_MAX_ENTRIES = 100;

/** Size limits for write tool by location: [soft_limit, hard_limit] in bytes */
export const WRITE_SIZE_LIMITS: Record<string, [number, number]> = {
  'MEMORY.md': [50 * 1024, 200 * 1024],
  'memory/': [100 * 1024, 500 * 1024],
  'clawspace/': [5 * 1024 * 1024, 20 * 1024 * 1024],
  'default': [1 * 1024 * 1024, 5 * 1024 * 1024],
};

/** Number of versions to retain in .versions/ directory */
export const WRITE_VERSION_RETENTION = 10;

// ----------------------------------------------------------------------------
// Execution Tools
// ----------------------------------------------------------------------------

/** Maximum stdout capture for exec tool */
export const EXEC_MAX_STDOUT = 8000;

/** Maximum stderr capture for exec tool */
export const EXEC_MAX_STDERR = 500;

// ----------------------------------------------------------------------------
// Subagent System
// ----------------------------------------------------------------------------

/** Default ReAct 步数上限（motion / claw / subagent 共用） */
export const DEFAULT_MAX_STEPS = 100;

/** Default timeout for subagent tasks (ms) - 5 minutes */
export const SUBAGENT_TIMEOUT_MS = 300000;

/** Default timeout for subagent tasks (seconds) - 5 minutes */
export const SPAWN_DEFAULT_TIMEOUT_S = 300;

/**
 * Default idle timeout for LLM calls: abort if no token output for this duration (ms)
 * User configurable via .clawforum/config.yaml: motion.llm_idle_timeout_ms (default: 60000)
 */
export const DEFAULT_LLM_IDLE_TIMEOUT_MS = 60000;

// ----------------------------------------------------------------------------
// Communication
// ----------------------------------------------------------------------------

/** Maximum inbox queue size */
export const INBOX_MAX_QUEUE_SIZE = 1000;

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
// Contract
// ----------------------------------------------------------------------------

/** 契约脚本验收超时 (ms) */
export const CONTRACT_SCRIPT_TIMEOUT_MS = 60_000;

// ----------------------------------------------------------------------------
// LLM Retry / Error Handling
// ----------------------------------------------------------------------------

/** Maximum retries for transient LLM failures in daemon loop */
export const LLM_MAX_RETRIES = 3;

/** Initial retry delay for LLM failures (ms) — doubles each retry up to max */
export const LLM_RETRY_INITIAL_DELAY_MS = 30_000;

/** Maximum retry delay for LLM failures (ms) — caps exponential backoff */
export const LLM_RETRY_MAX_DELAY_MS = 300_000;


