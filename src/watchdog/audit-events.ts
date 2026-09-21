// src/watchdog/audit-events.ts
/**
 * Watchdog audit event names.
 *
 * Module-owned event namespace per H1 design (phase336 / r36 α 决策 / H1 收官).
 * 字符串值与起步态 events.ts WATCHDOG_* + CLAW_CRASH_* 系列等价 / 0 漂移。
 *
 * Phase 1396 Step H: crash/inactivity/subscription motion-facing events retired.
 */
export const WATCHDOG_AUDIT_EVENTS = {
  CLEANUP_FAILED: 'watchdog_cleanup_failed',
  CRASH: 'watchdog_crash',
  CLAW_SCAN: 'watchdog_claw_scan',
  STATE_LOAD_FAILED: 'watchdog_state_load_failed',
  STATE_SCHEMA_INVALID: 'watchdog_state_schema_invalid',
  PID_CORRUPT: 'watchdog_pid_corrupt',
  PID_FOREIGN_WORKSPACE: 'watchdog_pid_foreign_workspace',
  PID_READ_FAILED: 'watchdog_pid_read_failed',
  PID_STALE_AUTO_CLEANED: 'watchdog_pid_stale_auto_cleaned',
  ORPHAN_SWEEP_KILLED: 'watchdog_orphan_sweep_killed',
  ORPHAN_SWEEP_FAILED: 'watchdog_orphan_sweep_failed',
  STOP: 'watchdog_stop',
  STREAM_READ_FAILED: 'watchdog_stream_read_failed',
  CONTRACT_DIR_SCAN_FAILED: 'watchdog_contract_dir_scan_failed',
  CLAW_DIR_LIST_FAILED: 'watchdog_claw_dir_list_failed',
  CLAWS_DIR_LIST_FAILED: 'watchdog_claws_dir_list_failed',
  WATCHDOG_RESTART_TRIGGERED: 'watchdog_restart_triggered',
  WATCHDOG_START: 'watchdog_start',
  WATCHDOG_CHECK: 'watchdog_check',
  HEARTBEAT_HOURLY: 'watchdog_heartbeat_hourly',
  // phase 324 H3: motion 连续 restart 失败触顶 → circuit-open、停 spawn
  WATCHDOG_GAVE_UP: 'watchdog_gave_up',
  // phase 723: GAVE_UP 后 motion 莫名恢复（外部 supervisor 拉起 / 手动重启）→ 解 circuit-open
  // 与 WATCHDOG_GAVE_UP 配对的 transition 锚点、forensic silent recovery 关键
  WATCHDOG_CIRCUIT_REOPENED: 'watchdog_circuit_reopened',
  // phase 1164: defer audit when next restart attempt is before nextAttemptAt
  WATCHDOG_RESTART_DEFERRED: 'watchdog_restart_deferred',
  // phase 1164: motion survived until next watchdog tick after spawn
  WATCHDOG_MOTION_STABILITY_CONFIRMED: 'watchdog_motion_stability_confirmed',
  // phase 346 B3 (review-2026-06-13): PID-reuse 探测 / argv 不匹配 skip kill
  ORPHAN_SWEEP_PID_REUSE_SKIPPED: 'watchdog_orphan_sweep_pid_reuse_skipped',
  PID_REUSE_DETECTED: 'watchdog_pid_reuse_detected',
  // phase 472 (review N3-L): stopCommand SIGTERM/SIGKILL syscall 失败可观察化
  STOP_SIGTERM_FAILED: 'watchdog_stop_sigterm_failed',
  STOP_SIGKILL_FAILED: 'watchdog_stop_sigkill_failed',
  // phase 1203: 目录位置 ownership 状态机（candidate→active→retired）
  OWNERSHIP_ATTEMPTED: 'watchdog_ownership_attempted',
  OWNERSHIP_COMMITTED: 'watchdog_ownership_committed',
  OWNERSHIP_LOST: 'watchdog_ownership_lost',
  OWNERSHIP_RETIRED: 'watchdog_ownership_retired',
  OWNERSHIP_MALFORMED_ACTIVE: 'watchdog_ownership_malformed_active',
  // phase 1203 Step D: dead/corrupt legacy watchdog.pid 保留证据迁移后放行
  OWNERSHIP_LEGACY_MIGRATED: 'watchdog_ownership_legacy_migrated',
  // phase 1247 Step B: generation terminal outcomes
  WATCHDOG_UNCLEAN_TERMINATION_DETECTED: 'watchdog_unclean_termination_detected',
  WATCHDOG_TERMINAL_WRITE_FAILED: 'watchdog_terminal_write_failed',
  WATCHDOG_TERMINAL_RECORDED: 'watchdog_terminal_recorded',
  // Phase 1396 Step F: claw daemon executor recovery events
  EXECUTOR_RECOVERY_SKIPPED: 'watchdog_executor_recovery_skipped',
  EXECUTOR_UNAVAILABLE_DELIVERED: 'watchdog_executor_unavailable_delivered',
  EXECUTOR_UNAVAILABLE_DELIVERY_FAILED: 'watchdog_executor_unavailable_delivery_failed',
  /** Phase 1803 Step B: failure 交付被永久拒绝（rejected），保留证据并上抛 */
  EXECUTOR_UNAVAILABLE_DELIVERY_REJECTED: 'watchdog_executor_unavailable_delivery_rejected',
  // Phase 1878 Step B: daemon 心跳监督（alive-but-loop-stale 发现与升级窗口显式语义）
  /** 进程 alive 但心跳过期 → 走既有重启 machinery（审计含判定依据） */
  EXECUTOR_HEARTBEAT_STALE: 'watchdog_executor_heartbeat_stale',
  /** 心跳缺失（旧版本升级窗口）/ 读取损坏 → unknown：不重启、不误判（tick 路由防噪声） */
  EXECUTOR_HEARTBEAT_UNKNOWN: 'watchdog_executor_heartbeat_unknown',
  /** Phase 1878 Step F: 损坏 evidence 显式隔离 + 审计（含原因与隔离位置，原文保留） */
  EXECUTOR_RECOVERY_EVIDENCE_CORRUPT: 'watchdog_executor_recovery_evidence_corrupt',
  /** Phase 1878 Step G: state.json 无效 executor 条目显式处置（key + 原因 + 原文隔离） */
  STATE_EXECUTOR_ENTRY_INVALID: 'watchdog_state_executor_entry_invalid',
} as const;


/**
 * Phase 163 / 1318 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 业务事件归 audit；心跳类事件（watchdog_check / watchdog_claw_scan）→ tick.tsv
 * （独立文件、30 天滚动、不进 audit.tsv 主文件）。
 * phase 1318 立（mirror daemon_liveness_heartbeat → tick 先例）。
 */
export const WATCHDOG_FILE_ROUTING: Readonly<Record<string, 'audit' | 'tick'>> = {
  watchdog_cleanup_failed: 'audit',
  watchdog_crash: 'audit',
  watchdog_claw_scan: 'tick',
  watchdog_state_load_failed: 'audit',
  watchdog_state_schema_invalid: 'audit',
  watchdog_pid_corrupt: 'audit',
  watchdog_pid_foreign_workspace: 'audit',
  watchdog_pid_read_failed: 'audit',
  watchdog_pid_stale_auto_cleaned: 'audit',
  watchdog_orphan_sweep_killed: 'audit',
  watchdog_orphan_sweep_failed: 'audit',
  watchdog_stop: 'audit',
  watchdog_stop_sigterm_failed: 'audit',
  watchdog_stop_sigkill_failed: 'audit',
  watchdog_stream_read_failed: 'audit',
  watchdog_contract_dir_scan_failed: 'audit',
  watchdog_claw_dir_list_failed: 'audit',
  watchdog_claws_dir_list_failed: 'audit',
  watchdog_restart_triggered: 'audit',
  watchdog_start: 'audit',
  watchdog_orphan_sweep_pid_reuse_skipped: 'audit',
  watchdog_pid_reuse_detected: 'audit',
  watchdog_check: 'tick',
  watchdog_gave_up: 'audit',
  watchdog_restart_deferred: 'audit',
  watchdog_motion_stability_confirmed: 'audit',
  watchdog_ownership_attempted: 'audit',
  watchdog_ownership_committed: 'audit',
  watchdog_ownership_lost: 'audit',
  watchdog_ownership_retired: 'audit',
  watchdog_ownership_malformed_active: 'audit',
  watchdog_ownership_legacy_migrated: 'audit',
  watchdog_unclean_termination_detected: 'audit',
  watchdog_terminal_write_failed: 'audit',
  watchdog_terminal_recorded: 'audit',
  watchdog_executor_recovery_skipped: 'audit',
  watchdog_executor_unavailable_delivered: 'audit',
  watchdog_executor_unavailable_delivery_failed: 'audit',
  watchdog_executor_unavailable_delivery_rejected: 'audit',
  watchdog_executor_heartbeat_stale: 'audit',
  watchdog_executor_heartbeat_unknown: 'tick',
  watchdog_executor_recovery_evidence_corrupt: 'audit',
  watchdog_state_executor_entry_invalid: 'audit',
} as const;
