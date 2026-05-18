/**
 * Heartbeat audit event names.
 *
 * Module-owned event namespace per H1 design (phase338 / r36 α 决策).
 * 字符串值与起步态 events.ts HEARTBEAT_ 系列等价 / 0 漂移。
 */
export const HEARTBEAT_AUDIT_EVENTS = {
  FIRE_FAILED: 'heartbeat_fire_failed',
  CHECKLIST_READ_FAILED: 'heartbeat_checklist_read_failed',
} as const;
