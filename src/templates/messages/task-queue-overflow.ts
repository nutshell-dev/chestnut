/**
 * M11 inbox 文案：任务队列溢出（系统通知正文 + motion guidance）。
 * 触发/接收者：AsyncTaskSystem pending 队列溢出 → 本 daemon 自家 inbox（task_queue_overflow，critical）
 * 及 motion guidance 追加。
 * 原 owner：core/async-task-system（正文）/ assembly guidance composer（指引文本）。
 *
 * 注意：同模块 task_result 异步结果文案不在本迁移范围。
 */

export function taskQueueOverflowBody(pendingQueueMax: number | string): string {
  return `Task queue is at capacity (${pendingQueueMax} pending). The system is unable to dispatch tasks fast enough — likely a chronic processing failure.`;
}

export function taskQueueOverflowGuidanceText(): string {
  return 'This is a system-level overload beyond agent control. Surface to the user immediately and ask them to report this to the developer. Do not retry dispatching new tasks.';
}
