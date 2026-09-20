/**
 * async-task-system 自有 stream 事件（task 生命周期，phase 1321 分层拆件）。
 * 恢复 1312 删的 const 名——同名同范围、task 模块自己的 const 归位。
 * 全量判别联合（含本 const 的 payload）归 CLI 汇总（viewport/stream-event-types.ts）。
 */
export const STREAM_TASK_EVENTS = {
  TASK_STARTED: 'task_started',
  TASK_ATTEMPT_START: 'task_attempt_start',
  TASK_COMPLETED: 'task_completed',
} as const;
