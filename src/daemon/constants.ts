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
 * Cooldown between startup_check notifications to prevent spam from rapid daemon restarts (ms).
 * Derivation: 10 * 60 * 1000 = 10 min / 给 daemon 真异常 restart loop 足够 cooldown 不灌爆 /
 * 比 HEARTBEAT_INTERVAL_SEC_DEFAULT (300s = 5 min) 长 2× 故 1 次 cooldown 内必有 1+ heartbeat.
 */
export const STARTUP_CHECK_COOLDOWN_MS = 10 * 60 * 1000;

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
 * phase 1383 (P2b U3): daemon in-process 自活 —— active 契约 + 等待态超长判定阈值（ms）.
 * Derivation: 300_000ms = 5min / 与 watchdog 旧 claw_inactivity_timeout_ms 同量级（Step C 退场后
 * 由 daemon 内化该兜底窗口）/ min 60_000ms 防过紧配置在正常长 turn 间隙误判 /
 * 必须 < Step D heartbeat_stale_timeout_ms，保证 in-process 自愈先于心跳重启（两层不竞争）.
 */
export const WAITING_STALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * phase 1383: waiting-stall 自愈连续失败上限 —— 达后 audit escalated 留痕（后续由 P2a 判失败兜底）.
 * Derivation: 3 = 经验值 / 每次自愈强制重入轮，连续 3 轮仍无活动约 15min 视为真停滞 /
 * 本 phase 不接判失败，仅 escalated 审计留痕.
 */
export const WAITING_STALL_MAX_SELF_HEAL_ATTEMPTS = 3;

/**
 * phase 1383: waiting-stall 检查定时器节拍（ms）.
 * Derivation: 60_000ms = 60s / 与 LIVENESS_HEARTBEAT_MS 同节拍复用 /
 * 粒度 = 阈值 1/5，误判/漏判窗口可接受.
 */
export const WAITING_STALL_CHECK_INTERVAL_MS = 60_000;

/**
 * phase 1383 Step D (U4): daemon 心跳文件写间隔（ms）.
 * 心跳文件 = Watchdog 进程外兜底：事件循环全阻塞（sync 卡死）时 in-process 定时器
 * 也不触发，Watchdog 靠心跳时间戳过期判定「功能死」并复用 crash 重启状态机重启.
 * Derivation: 30_000ms = 30s / 与 watchdog tick（WATCHDOG_INTERVAL_MS=30s）同量级 /
 * 比 LIVENESS_HEARTBEAT_MS(60s) 密一倍，保证 tick 之间至少有一次新鲜写 /
 * HEARTBEAT_STALE_TIMEOUT_MS 取 max(3× 写间隔, WAITING_STALL_TIMEOUT_MS)，
 * 保证 in-process 自愈先于心跳重启（两层不竞争）.
 */
export const DAEMON_HEARTBEAT_WRITE_INTERVAL_MS = 30_000;

/** 心跳文件名（落 daemon 自己的 agentDir 根，即 PM daemonDir）. */
export const DAEMON_HEARTBEAT_FILENAME = 'heartbeat';

/**
 * phase 1387 Step B: waiting-stall escalated 后取消 active 契约的失败 reason。
 * 语义：agent 在持有 active 契约时长时间无活动、自愈无效，由 daemon 判为自发停滞。
 */
export const WAITING_STALL_CONTRACT_FAIL_REASON = 'agent_spontaneous_stall';

