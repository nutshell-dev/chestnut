/**
 * M11 inbox 文案：任务队列溢出（系统通知正文）。
 * 触发/接收者：AsyncTaskSystem pending 队列溢出 → 本 daemon 自家 inbox（task_queue_overflow，critical）。
 * 原 owner：core/async-task-system（正文）。
 *
 * phase 1836：正文改为最小事实对象——本次被拒绝任务身份、拒绝处置前观测的队列数量
 * 与上限、系统已执行处置（记失败 + 另行投递失败结果）。不再推断长期故障，旧 motion
 * guidance（升级用户/停派指令）已退役（composer 采用 NO_GUIDANCE，注册保留）。
 *
 * 注意：同模块 task_result 异步结果文案不在本迁移范围。
 */

export function taskQueueOverflowBody(input: {
  readonly taskId: string;
  readonly queueLength: number;
  readonly cap: number;
}): string {
  return [
    '一次异步任务提交因待处理队列超限被拒绝。',
    `任务：${input.taskId}`,
    `检查时队列数量：${input.queueLength}；上限：${input.cap}`,
    '',
    '系统已将该任务记为失败，并另行投递失败结果。',
    '上述数量是拒绝发生前的观测值，收到通知时队列状态可能已经变化。',
  ].join('\n');
}
