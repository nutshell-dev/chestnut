/**
 * Heartbeat audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts HEARTBEAT_ 系列等价 / 0 漂移。
 */
export const HEARTBEAT_AUDIT_EVENTS = {
  FIRE_FAILED: 'heartbeat_fire_failed',
  CHECKLIST_READ_FAILED: 'heartbeat_checklist_read_failed',
  CLOCK_ROLLBACK: 'heartbeat_clock_rollback', // ← NEW phase 1767: wall-clock 回拨重锚定事实（HEARTBEAT-WALL-CLOCK-ROLLBACK-STALL）
} as const;


/**
 * Phase 163 业主声明 file 归属（phase 122 §5.A + §6.7 + phase 159 模式）.
 *
 * 全 'audit'：业务事件归业务事件主 file（信噪比已通过 cron tick 分流改善）.
 */
export const HEARTBEAT_FILE_ROUTING: Readonly<Record<string, 'audit'>> = {
  heartbeat_fire_failed: 'audit',
  heartbeat_checklist_read_failed: 'audit',
  heartbeat_clock_rollback: 'audit',
} as const;
