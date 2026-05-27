// src/core/async-task-system/stream-events.ts
/**
 * AsyncTaskSystem stream event names.
 *
 * Module-owned event namespace for stream.jsonl payload `type` field.
 * 字符串值 + 模块自治 const 集合 / 与既有 stream 起步态等价 / 0 漂移。
 *
 * 注：仅含 task lifecycle 事件 / 不含 chat message / tool_use / tool_result 等
 * 跨 LLM SDK schema 范畴（推 r76+ 同型再遇加 const）。
 */
export const STREAM_TASK_EVENTS = {
  TASK_STARTED: 'task_started',
  TASK_ATTEMPT_START: 'task_attempt_start',
} as const;
