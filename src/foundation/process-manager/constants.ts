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
/**
 * phase 355 C1 (review-2026-06-13): SIGKILL 后等 kernel 异步 reap 进程的 grace (ms).
 * stopProcess 删 PID 文件前 verify-loop 上限；超时仍未死 → audit 留诊断、仍删
 * （不阻 stop 完成；这是诊断信号、不是正确性 invariant）。
 * Value: 1000 (1s) — kernel reap 一般 ms 级、给足缓冲；超时罕见、出现即应人介入。
 */
export const SIGKILL_DEAD_VERIFY_GRACE_MS = 1000;
