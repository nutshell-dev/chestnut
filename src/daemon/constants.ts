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
 * phase 1873 Step G（daemon-startup-state-in-process-manager-dir）：daemon-owned 状态子目录
 * （agentDir 相对；与 event-loop/ 等模块目录同型）。原 startup_check_ts 写 PM 的
 * status/（STATUS_SUBDIR）——Daemon 私有 schema 不再落 PM 资源目录。
 * legacy 读取兼容（迁移期）见 startup-check.ts。
 */
export const DAEMON_STATE_DIR = 'daemon' as const;

/** startup cooldown 时间戳文件名（语义不变：H 步的投递关联身份）。 */
export const STARTUP_CHECK_TS_FILE = 'startup_check_ts' as const;

/**
 * Cooldown between startup_check notifications to prevent spam from rapid daemon restarts (ms).
 * Derivation: 10 * 60 * 1000 = 10 min / 给 daemon 真异常 restart loop 足够 cooldown 不灌爆.
 */
export const STARTUP_CHECK_COOLDOWN_MS = 10 * 60 * 1000;

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

