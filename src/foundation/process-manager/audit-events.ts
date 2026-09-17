/**
 * ProcessManager audit event names.
 *
 * Module-owned event namespace per H1 design (phase334 / r36 α 决策)。
 * 字符串值与 phase148 起 events.ts 中央注册表的等价条目 0 漂移。
 *
 * 注意：catalog 只承载真实可触发的 owner 事件。phase 1852 Step C 删除 24 条零引用遗留
 * （legacy lock/lockfile/flat-PID/ready-mark/starttime 系，协议已被 generation CAS 取代）；
 * 未来如需新事件按「真实可触发时再加」原则新增（YAGNI）。
 */
export const PROCESS_MANAGER_AUDIT_EVENTS = {
  PROCESS_SPAWNED: 'process_spawned',
  PROCESS_SPAWN_FAILED: 'process_spawn_failed',
  PROCESS_SPAWN_POST_COMMIT_FAILED: 'process_spawn_post_commit_failed', // ← NEW phase 1763: detached spawn 提交点后异步失败（原始 errno 证据）
  PROCESS_STOPPED: 'process_stopped',
  PROCESS_STOP_FAILED: 'process_stop_failed',
  PROCESS_KILL_ESCALATED: 'process_kill_escalated',
  ORPHAN_SIGTERM_FAILED: 'orphan_sigterm_failed',
  ORPHAN_CLEANUP_PARTIAL: 'orphan_cleanup_partial', // ← NEW phase 1060
  ORPHAN_CLEANUP_BLOCKED: 'orphan_cleanup_blocked', // ← phase 1779: cleanup 无法证明完成、spawn fail-closed
  ORPHAN_MATCH_SKIPPED: 'orphan_match_skipped', // ← phase 346 B2: clawId token-match miss、防误杀 sibling claw
  STOP_PROCESS_SURVIVED_SIGKILL: 'stop_process_survived_sigkill',
  PROCESS_LIST_FAILED: 'process_list_failed',
  READY_MARK_STALE: 'process_ready_mark_stale',
  READY_CHECK_ISALIVE_THROW: 'process_ready_check_isalive_throw',
  CLEAN_STOP_SIGNALED: 'clean_stop_signaled',
  CLEAN_STOP_CLEARED: 'clean_stop_cleared',
  GENERATION_PREPARED: 'process_generation_prepared', // ← NEW phase 1204 Step A
  GENERATION_COMMITTED: 'process_generation_committed', // ← NEW phase 1204 Step A
  GENERATION_COMMIT_LOST: 'process_generation_commit_lost', // ← NEW phase 1204 Step A
  GENERATION_MALFORMED: 'process_generation_malformed', // ← NEW phase 1204 Step A
  GENERATION_PID_WROTE: 'process_generation_pid_wrote', // ← NEW phase 1204 Step A
  GENERATION_READY_WROTE: 'process_generation_ready_wrote', // ← NEW phase 1204 Step C
  GENERATION_ACTIVATED: 'process_generation_activated', // ← NEW phase 1204 Step A
  GENERATION_RETIRED: 'process_generation_retired', // ← NEW phase 1204 Step A
  GENERATION_FAILED: 'process_generation_failed', // ← NEW phase 1204 Step A
  ENSURE_JOINED: 'process_ensure_joined', // ← NEW phase 1282 Step A: join foreign winner 至 ready
  ENSURE_FAILED: 'process_ensure_failed', // ← NEW phase 1282 Step A: join 未收敛 typed failure
  STOP_INTENT_RECORDED: 'process_stop_intent_recorded', // ← NEW phase 1204 Step D
  STOP_INTENT_SCAN_FAILED: 'process_stop_intent_scan_failed', // ← NEW phase 1204 Step F
  STOP_INTENT_MALFORMED: 'process_stop_intent_malformed', // ← NEW phase 1204 Step F
  STOP_LATE_TARGET_MISMATCH: 'process_stop_late_target_mismatch', // ← NEW phase 1204 Step F
  STOP_TARGET_RELOCATED: 'process_stop_target_relocated', // ← NEW phase 1204 Step F
  STOP_IDEMPOTENT: 'process_stop_idempotent', // ← NEW phase 1204 Step D
} as const;
