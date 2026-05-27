/**
 * @module L4.SpawnSystem.AuditEvents
 * spawn-system 审计事件常量 / phase 766 sync 路径 wire (Phase YYY ratified).
 * SUNSET per phase 1258: 当 sync 路径 NEW audit event 立时本注释 sweep.
 *
 * 注：现有 spawn 工具经 AsyncTaskSystem.schedule 内 TASK_AUDIT_EVENTS.TASK_SCHEDULED 落 audit /
 * 该 const 仍归 async-task-system own / spawn-system 不重复定义。
 */

export const SPAWN_AUDIT_EVENTS = {
  SYNC_STARTED: 'spawn_sync_started',
  SYNC_FINISHED: 'spawn_sync_finished',
  SYNC_FAILED: 'spawn_sync_failed',
} as const;
