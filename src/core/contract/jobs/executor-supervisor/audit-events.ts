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
} as const;

/** 由 EXECUTOR_SUPERVISOR_AUDIT_EVENTS 派生的窄事件 union。 */
export type ExecutorSupervisorAuditEvent =
  (typeof EXECUTOR_SUPERVISOR_AUDIT_EVENTS)[keyof typeof EXECUTOR_SUPERVISOR_AUDIT_EVENTS];
