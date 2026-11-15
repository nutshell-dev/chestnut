/**
 * @module L4.ContractSystem.ExecutorSupervisor
 * Phase 1974 Step B: audit events 命名空间业主自治.
 * 字符串值稳定（wire 格式）；全部默认 audit file、不新增 fileRouting。
 */

export const EXECUTOR_SUPERVISOR_AUDIT_EVENTS = {
  /** dead/absent 经 ensureDaemon 收敛（outcome=spawned|already_ready|joined）。 */
  ENSURED: 'executor_supervisor_ensured',
  /** ensureDaemon 抛错（trigger=dead|absent 保留）。 */
  START_FAILED: 'executor_supervisor_start_failed',
  /** alive + heartbeat stale 经 restartDaemon 收敛（stop_outcome 显式记录）。 */
  RESTARTED: 'executor_supervisor_restarted',
  /** restartDaemon 抛错。 */
  RESTART_FAILED: 'executor_supervisor_restart_failed',
  /** alive 但心跳超过 stale 阈值（restart 前事实记录）。 */
  HEARTBEAT_STALE: 'executor_supervisor_heartbeat_stale',
  /** 心跳 missing/corrupt/read_failed → 显式 unknown，不重启、不误杀。 */
  HEARTBEAT_UNKNOWN: 'executor_supervisor_heartbeat_unknown',
  /** 显式跳过：resolve_failed / non_local / malformed / probe_unavailable / internal_error。 */
  SKIPPED: 'executor_supervisor_skipped',
  /** clawTopology.enumerate 抛错（本 tick 无候选）。 */
  SCAN_FAILED: 'executor_supervisor_scan_failed',
  /** 单 claw active contract 扫描抛错（跳过该 claw）。 */
  CONTRACT_SCAN_FAILED: 'executor_supervisor_contract_scan_failed',
  /** liveness probe 抛错（跳过该 claw；≠ dead）。 */
  LIVENESS_PROBE_FAILED: 'executor_supervisor_liveness_probe_failed',
  /** 恢复动作失败已写入持久 intent（attempt/next_attempt_at/circuit 可重建）。 */
  RECOVERY_SCHEDULED: 'executor_supervisor_recovery_scheduled',
  /** 持久 backoff 窗口未到期；不 probe、不重复恢复动作。 */
  RECOVERY_DEFERRED: 'executor_supervisor_recovery_deferred',
  /** recovery state 读取失败或 schema 损坏；安全跳过。 */
  RECOVERY_STATE_UNREADABLE: 'executor_supervisor_recovery_state_unreadable',
  /** rename 前写失败；action_succeeded 区分失败调度与成功屏障。 */
  RECOVERY_STATE_WRITE_FAILED: 'executor_supervisor_recovery_state_write_failed',
  /** rename 已提交但目录耐久性降级；仍按已写入处理。 */
  RECOVERY_STATE_WRITE_DEGRADED: 'executor_supervisor_recovery_state_write_degraded',
  /** 动作成功或观察到外部恢复后，持久 intent 已清理。 */
  RECOVERY_CLEARED: 'executor_supervisor_recovery_cleared',
  /** 动作已成功但清理失败；action_succeeded 屏障留给下一 tick 复核。 */
  RECOVERY_CLEAR_FAILED: 'executor_supervisor_recovery_clear_failed',
} as const;

/** 由 EXECUTOR_SUPERVISOR_AUDIT_EVENTS 派生的窄事件 union。 */
export type ExecutorSupervisorAuditEvent =
  (typeof EXECUTOR_SUPERVISOR_AUDIT_EVENTS)[keyof typeof EXECUTOR_SUPERVISOR_AUDIT_EVENTS];
