export const DAEMON_AUDIT_EVENTS = {
  // spawn / lifecycle
  SPAWN_ATTEMPT: 'daemon_spawn_attempt',
  SPAWN_SUCCESS: 'daemon_spawn_success',
  SPAWN_FAILED: 'daemon_spawn_failed',
  FORK_ATTEMPT: 'daemon_fork_attempt',
  FORK_FAILED: 'daemon_fork_failed',
  STOP_ATTEMPT: 'daemon_stop_attempt',
  STOP_SUCCESS: 'daemon_stop_success',
  STOP_FAILED: 'daemon_stop_failed',
  // snapshot 路径（daemon.ts）
  SNAPSHOT_COMMIT_UNCATEGORIZED: 'snapshot_commit_uncategorized',
  SNAPSHOT_COMMIT_FAILED: 'snapshot_commit_failed',
  // daemon-loop 路径
  LOOP_INTERRUPT_POLLER_DISABLED: 'daemon_loop_interrupt_poller_disabled',
  LOOP_INTERRUPT_POLLER_ERROR: 'daemon_loop_interrupt_poller_error',
  LOOP_INTERRUPT_POLLER_RECOVERED: 'daemon_loop_interrupt_poller_recovered',
  LOOP_INTERRUPT_POLLER_RECOVERY_ATTEMPT: 'daemon_loop_interrupt_poller_recovery_attempt',
  LOOP_ITERATION: 'daemon_loop_iteration',
  LOOP_INTERRUPT: 'daemon_loop_interrupt',
  LOOP_LLM_RETRY: 'daemon_loop_llm_retry',
  LOOP_FATAL: 'daemon_loop_fatal',
  LIVENESS_HEARTBEAT: 'daemon_liveness_heartbeat',
  // cleanup 路径
  CLEANUP_HEARTBEAT_FAILED: 'daemon_cleanup_heartbeat_failed',
  CLEANUP_PID_FAILED: 'daemon_cleanup_pid_failed',
  // other
  IDLE_TIMEOUT: 'daemon_idle_timeout',
  CONTRACT_CANCELLED: 'contract_cancelled',
  CRASH_NOTIFICATION: 'crash_notification',
  DAEMON_EXIT_ZERO: 'daemon_exit_zero',
  LLM_RETRY_STATE_INVARIANT_VIOLATED: 'daemon_llm_retry_state_invariant_violated',
  LLM_RETRY_STATE_LOAD_FAILED: 'daemon_llm_retry_state_load_failed',
  // NEW phase 272 Step B: raw audit emit migration to const SoT
  UNHANDLED_REJECTION: 'daemon_unhandled_rejection',
  UNCAUGHT_EXCEPTION: 'daemon_uncaught_exception',
  // phase 324 H4: motion 自审 watchdog 存活 / 不活时 audit（dedup 单次/dead-streak）
  WATCHDOG_MISSING: 'watchdog_missing',
} as const;

/**
 * `spawn_failed` 等异常结束事件、用于 audit 触发通知。
 */
export type DaemonAuditEvent = typeof DAEMON_AUDIT_EVENTS[keyof typeof DAEMON_AUDIT_EVENTS];

/**
 * Phase 159 业主声明 file 归属（phase 122 §5.A + §6.7）.
 *
 * daemon_liveness_heartbeat / daemon_loop_iteration → tick（高频）、
 * 其余异常 / 业务 event 留 audit（默认主 file）.
 */
export const DAEMON_FILE_ROUTING: Readonly<Record<string, 'audit' | 'tick'>> = {
  daemon_liveness_heartbeat: 'tick',
  daemon_loop_iteration: 'tick',
} as const;

export const LOOP_ITERATION_TYPES = {
  CHAIN: 'chain',
  CHAIN_LIMITED: 'chain_limited',
  WAIT: 'wait',
} as const;

export const LOOP_INTERRUPT_CAUSES = {
  IDLE_TIMEOUT: 'idle_timeout',
  USER_INTERRUPT: 'user_interrupt',
  PRIORITY_INBOX: 'priority_inbox',
} as const;
