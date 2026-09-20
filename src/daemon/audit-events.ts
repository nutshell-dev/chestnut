export const DAEMON_AUDIT_EVENTS = {
  // phase 1873 Step J（daemon-lifecycle-events-owned-by-assembly）：进程生命周期
  // 事件归 Daemon owner（原声明在 assembly/audit-events.ts；字面 1:1 迁移不断链）：
  // - daemon_start / daemon_crash：daemon 进程起停事实；
  // - daemon_pre_runtime_failed：装配成功后、进入驱动前/启动期的失败（携 stage），
  //   与装配内部失败（assemble_failed，Assembly owner）可区分。
  DAEMON_START: 'daemon_start',
  DAEMON_CRASH: 'daemon_crash',
  PRE_RUNTIME_FAILED: 'daemon_pre_runtime_failed',
  // snapshot 路径（daemon.ts）
  SNAPSHOT_COMMIT_UNCATEGORIZED: 'snapshot_commit_uncategorized',
  SNAPSHOT_COMMIT_FAILED: 'snapshot_commit_failed',
  // daemon-loop 路径
  LOOP_INTERRUPT_POLLER_DISABLED: 'daemon_loop_interrupt_poller_disabled',
  LOOP_INTERRUPT_POLLER_ERROR: 'daemon_loop_interrupt_poller_error',
  LOOP_INTERRUPT_POLLER_RECOVERED: 'daemon_loop_interrupt_poller_recovered',
  LOOP_INTERRUPT_POLLER_RECOVERY_ATTEMPT: 'daemon_loop_interrupt_poller_recovery_attempt',
  LOOP_INTERRUPT_POLLER_RECOVERY_FAILED: 'daemon_loop_interrupt_poller_recovery_failed',
  LOOP_FATAL: 'daemon_loop_fatal',
  LIVENESS_HEARTBEAT: 'daemon_liveness_heartbeat',
  LIVENESS_HOURLY: 'daemon_liveness_hourly',
  // phase 1878 Step B: 心跳事实落盘失败（写失败可观察、不阻断 daemon）
  HEARTBEAT_WRITE_FAILED: 'daemon_heartbeat_write_failed',
  // cleanup 路径
  CLEANUP_HEARTBEAT_FAILED: 'daemon_cleanup_heartbeat_failed',
  CLEANUP_PID_FAILED: 'daemon_cleanup_pid_failed',
  // NEW phase 272 Step B: raw audit emit migration to const SoT
  UNHANDLED_REJECTION: 'daemon_unhandled_rejection',
  UNCAUGHT_EXCEPTION: 'daemon_uncaught_exception',
  // phase 851: startup-check I/O 错误可观察
  STARTUP_CHECK_IO_ERROR: 'daemon_startup_check_io_error',
  // phase 1794: startup check 投递 pending_retry（stage/error 证据，下 tick 重试）
  STARTUP_CHECK_RETRY: 'daemon_startup_check_retry',
  // phase 1873 Step H: fresh ts 无消息证据（提交后崩溃未投递）→ 重投递留痕
  STARTUP_CHECK_TS_WITHOUT_DELIVERY: 'daemon_startup_check_ts_without_delivery',
  LAST_EXIT_SUMMARY_READ_FAILED: 'daemon_last_exit_summary_read_failed',
  // phase 1124: shutdown 重入 guard 留痕
  SHUTDOWN_REENTRY_SUPPRESSED: 'daemon_shutdown_reentry_suppressed',
} as const;

/**
 * `spawn_failed` 等异常结束事件、用于 audit 触发通知。
 */
export type DaemonAuditEvent = typeof DAEMON_AUDIT_EVENTS[keyof typeof DAEMON_AUDIT_EVENTS];

/**
 * Phase 159 业主声明 file 归属（phase 122 §5.A + §6.7）.
 *
 * daemon_liveness_heartbeat → tick（高频）、
 * 其余异常 / 业务 event 留 audit（默认主 file）.
 */
export const DAEMON_FILE_ROUTING: Readonly<Record<string, 'audit' | 'tick'>> = {
  daemon_liveness_heartbeat: 'tick',
} as const;
