/** Daemon stdout log file path / phase 1364 r-phase1364 物理迁自 src/cli/constants.ts（ML#3 daemon stdout 输出资源归 daemon 单 owner / cli + watchdog launcher 都是 setter）*/
export const DAEMON_LOG = 'logs/daemon.log';

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

/** Interrupt poller 轮询间隔（ms）/ daemon 内 inbox.priority queue 检测频率 */
export const INTERRUPT_POLL_INTERVAL_MS = 200;

/** Interrupt poller 连续错误时 warn 触发频次（每 N 次 emit 1 warn）*/
export const INTERRUPT_POLL_WARN_EVERY = 5;

/** Interrupt poller 连续错误上限（达后禁 poller + emit LOOP_INTERRUPT_POLLER_DISABLED audit）*/
export const INTERRUPT_POLL_MAX_ERRORS = 20;

/**
 * ReAct chain 单 tick 内 batch 最大轮数 / 防 runaway 安全闸.
 * 达 cap 时 emit LOOP_ITERATION_TYPES.CHAIN_LIMITED audit / chain 强制结束本 tick.
 */
export const REACT_CHAIN_MAX_ITERATIONS = 100;
