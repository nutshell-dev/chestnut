/** Watchdog liveness check interval (ms) */
export const WATCHDOG_INTERVAL_MS = 30_000;

/** Disk warning threshold (MB) */
export const DEFAULT_DISK_WARNING_MB = 500;

/** Watchdog log file path (relative to chestnut root) */
export const WATCHDOG_LOG = 'logs/watchdog.log';

/**
 * phase 1383 Step D (U4): 心跳文件过期阈值（ms）—— 进程外兜底「功能死」判定.
 * Derivation: max(3 × DAEMON_HEARTBEAT_WRITE_INTERVAL_MS(30s)=90s,
 *   WAITING_STALL_TIMEOUT_MS(300s)) = 300s / 取 in-process 自活超时为下界，
 *   保证 in-process waiting-stall 自愈（5min）先于心跳重启触发，两层不竞争 /
 *   3× 写间隔防抖：单次 tick 漏写/调度抖动不误判.
 * Watchdog 读到「进程 alive + 心跳时间戳超此阈值」→ 复用 crash 重启状态机重启.
 * 注：此处不 import daemon/constants（Watchdog 不反向依赖 Daemon 内部常量），
 *   值与两侧推导同步、由测试锁定.
 */
export const HEARTBEAT_STALE_TIMEOUT_MS = 5 * 60 * 1000;
