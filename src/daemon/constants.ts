/** Daemon stdout log file path / phase 1364 r-phase1364 物理迁自 src/cli/constants.ts（M#3 daemon stdout 输出资源归 daemon 单 owner / cli + watchdog launcher 都是 setter）*/
export const DAEMON_LOG = 'logs/daemon.log';

/**
 * Default fallback timeout for daemon operations (ms).
 * Derivation: 30000ms = 30s 给 daemon 内部 fallback path（waitForInbox 等）兜底 / 比
 * INTERRUPT_POLL_INTERVAL_MS (200ms) 长 150× 因 fallback 是 last-resort 而非 hot path /
 * 与 DAEMON_SHUTDOWN_GRACE_MS (5s) 同级 budget 但更宽因含 LLM/IO 等待.
 */
export const DAEMON_FALLBACK_TIMEOUT_MS = 30000;

/**
 * Delay after interrupt recovery before processing next message (ms).
 * Derivation: 1000ms = 1s 给 interrupt cleanup completion 后 settle 时间 /
 * 配 INTERRUPT_POLL_INTERVAL_MS=200ms 即 ≈ 5 个 poll cycle / 防 cleanup→next msg 紧贴致竞态.
 */
export const INTERRUPT_RECOVERY_DELAY_MS = 1000;

/**
 * Cooldown between startup_check notifications to prevent spam from rapid daemon restarts (ms).
 * Derivation: 10 * 60 * 1000 = 10 min / 给 daemon 真异常 restart loop 足够 cooldown 不灌爆 /
 * 比 HEARTBEAT_INTERVAL_SEC_DEFAULT (300s = 5 min) 长 2× 故 1 次 cooldown 内必有 1+ heartbeat.
 */
export const STARTUP_CHECK_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Maximum retries for transient LLM failures in daemon loop.
 * Derivation: 3 = 经验值 / 1-2 retry 化解 transient API/network 抖动 / ≥ 3 视为 provider/quota
 * 真问题 fail-loud / 配 DEFAULT_VERIFICATION_ATTEMPTS=3 同型经验值.
 */
export const LLM_MAX_RETRIES = 3;

/**
 * Initial retry delay for LLM failures (ms) — doubles each retry up to max.
 * Derivation: 30_000ms = 30s / 比 typical API rate-limit window (60s) 短一半给 server 缓和 /
 * 配 LLM_MAX_RETRIES=3 exponential backoff: 30s → 60s → 120s 总 ≈ 3.5 min budget /
 * 配 LLM_RETRY_MAX_DELAY_MS=300s 即 5min cap.
 */
export const LLM_RETRY_INITIAL_DELAY_MS = 30_000;

/**
 * Maximum retry delay for LLM failures (ms) — caps exponential backoff.
 * Derivation: 300_000ms = 5 min / exponential 系列从 LLM_RETRY_INITIAL_DELAY_MS=30s 走 10×
 * cap 即足以化解长 rate-limit / 同 SUBAGENT_TIMEOUT_MS=5min 同 budget.
 */
export const LLM_RETRY_MAX_DELAY_MS = 300_000;

/**
 * Interrupt poller 轮询间隔（ms）/ daemon 内 inbox.priority queue 检测频率.
 * Derivation: 200ms ≈ 用户 interrupt 触发到 daemon 响应延迟（< user-perceptible 250ms）/
 * 比 GATEWAY_INTERRUPT_DEBOUNCE_MS (500ms) 紧 2.5× 保 debounce 后 1 cycle 内 ack /
 * 与 MIN_DWELL_MS (200) 同值（共享 user-perceptible 物理阈值）.
 */
export const INTERRUPT_POLL_INTERVAL_MS = 200;

/**
 * Interrupt poller 连续错误时 warn 触发频次（每 N 次 emit 1 warn）.
 * Derivation: 5 = 经验值 / N=5 + INTERRUPT_POLL_INTERVAL_MS=200ms ≈ 1s 频次 warn /
 * 平衡 audit 噪声 vs 真问题信号 / 配 INTERRUPT_POLL_MAX_ERRORS=20 即每 4 次 warn 触发 disable.
 */
export const INTERRUPT_POLL_WARN_EVERY = 5;

/**
 * Interrupt poller 连续错误上限（达后禁 poller + emit LOOP_INTERRUPT_POLLER_DISABLED audit）.
 * Derivation: 20 errors = INTERRUPT_POLL_INTERVAL_MS (200ms) × 20 = 4s 连续异常窗口 /
 * 视为 inbox 真坏需 disable poller 防资源浪费 / 配 INTERRUPT_POLL_WARN_EVERY=5 即 disable 前 emit 4 warn.
 */
export const INTERRUPT_POLL_MAX_ERRORS = 20;

/**
 * Interrupt poller disable 后 recovery backoff（ms）/ phase 229: DP「中断可恢复」+ M#8 接口最小.
 * Derivation: 30_000ms = 30s 给 inbox 真故障 cooldown 时间 / 配 LLM_RETRY_INITIAL_DELAY_MS=30s 同型
 * 经验值 / 防 disable→recovery 频繁切换灌爆 audit.
 */
export const INTERRUPT_POLL_RECOVERY_BACKOFF_MS = 30_000;

/**
 * ReAct chain 单 tick 内 batch 最大轮数 / 防 runaway 安全闸.
 * 达 cap 时 emit LOOP_ITERATION_TYPES.CHAIN_LIMITED audit / chain 强制结束本 tick.
 */
export const REACT_CHAIN_MAX_ITERATIONS = 100;
