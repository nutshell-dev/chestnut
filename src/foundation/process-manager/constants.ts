/**
 * SIGTERM → SIGKILL grace period (ms).
 *
 * Time given to a process after SIGTERM before force-killing with SIGKILL.
 *
 * Value: 5000 (5s) = empirical / matches Linux init scripts default + systemd
 * KillMode default / 平衡 graceful shutdown vs response latency.
 */
export const DAEMON_SHUTDOWN_GRACE_MS = 5000;
/**
 * Poll interval while waiting for spawn confirmation (ms).
 *
 * Value: 50ms = empirical / 平衡 user-perceived latency vs CPU usage
 * （< 100ms 人感不可察 / > 200ms 用户察觉等待）.
 */
export const SPAWN_POLL_INTERVAL_MS = 50;
/**
 * SIGTERM 后等进程退出的轮询间隔（ms）.
 * 在 DAEMON_SHUTDOWN_GRACE_MS deadline 内每隔此周期 isAlive check.
 */
export const PROCESS_STOP_POLL_INTERVAL_MS = 100;
