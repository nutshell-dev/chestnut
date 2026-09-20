// phase 471: constants barrel re-export
export {
  DEFAULT_MAX_CONCURRENT_TASKS,
  ASYNC_EXEC_SOFT_TIMEOUT_MS,
} from './constants.js';

/**
 * @module L4.AsyncTaskSystem
 * Task system exports
 */

export { AsyncTaskSystem, createAsyncTaskSystem } from './system.js';
// phase 1790: 取消业务语义 owner typed outcome（pending 通知失败显式可观察）
export type { CancelOutcome } from './system.js';
export { PersistentShortIdIndex } from './short-id-index.js';
export { validateTaskShape } from './task-corrupt-helpers.js';
export { ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES } from './inbox-formatter.js';
export type {
  SubAgentTask,
  PreparedSubagentSchedule,
  SubAgentTaskScheduler,
  PreparedSubAgentTaskScheduler,
  AsyncTaskRuntimeLifecycle,
  TaskLifecycleOutcome,
  AbortRequestOutcome,
  TaskId,
  FullTaskId,
  ShortTaskId,
  TaskIdResolver,
  ShortIdIndex,
  ExecutorPayloadAdapter,
  ExecutorPayloadInterpretation,
  RunningTaskView,
  TaskExecutor,
  TaskExecutionRuntime,
  TaskExecutionOutcome,
  DeliverySink,
  TaskDeliveryRuntime,
} from './types.js';
export { makeShortTaskId, makeFullTaskId, makeTaskId, deriveShortIdFromTaskId } from './types.js';
// phase 1863 (AT-D11)：反序列化入口（宽容读）+ legacy 采纳（读路径专用）
export { readFullTaskId, readShortTaskId, adoptLegacyFullTaskId, adoptLegacyShortTaskId } from './types.js';
export type { PostProcessor } from './post-processors/types.js';
export type { ProcessedTaskResult } from './result-delivery-types.js';

// phase 1863 (AT-D10) 收口：processed-result-store 机制面内化（barrel 撤出）——
// ProcessedResultStore/createProcessedResultStore/ProcessedTaskResultSchema/3 错误类
// 由模块内与测试经深链消费（无 barrel 消费方）；需要时经 owner 面再开。

// phase 1863 (AT-D10) 收口：envelope 文件名机制面内化（POST_PROCESS_INPUT_FILE/
// RESULT_META_FILE/RESULT_ENVELOPE_FILE 由深链消费）；
// TASKS_QUEUES_* 保留（装配布局/权限/CLI 读路径依赖；收窄候选登记于 barrel 锁注释）。
export {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASK_SNAPSHOT_IGNORE,  // phase 693 Step B
} from './dirs.js';

export { classifyTaskError } from './_helpers.js';
export { createStandardDeliverySink } from './result-delivery.js';
// phase 1863 (AT-D5)：executor adapter 消费面（执行留痕 + shortId 派生）
export { emitHandlerFailed } from './audit-emit.js';
export { taskShortId } from './types.js';

// phase 481: TASK_AUDIT_EVENTS barrel re-export
export { TASK_AUDIT_EVENTS } from './audit-events.js';
// phase 485: task-schemas type barrel re-export
// phase 1863 (AT-D10) 收口：SummonDecisionMetadata 内化（零外部消费；1866 summon 面需要时再开）
export type { LegacySummonDecisionV1 } from './task-schemas.js';

// phase 1130: typed audit emit functions
// phase 1302: 32 个 emit* 符号在 src + tests 中经 barrel 消费全为 0；撤销 phase 132 wildcard。
// audit-emit.js 仍由模块内文件深链消费，barrel 不再对外 re-export。




// phase 843: migrated exec task query API
export { listMigratedExecTasks } from './list-migrated-exec.js';
export type { MigratedExecTaskInfo, TaskReadError } from './list-migrated-exec.js';

// phase 1758: task queue 最小只读 capability（STATUS-TASK-QUEUE-OWNER-BYPASS 修复）
export { readTaskQueueCounts } from './task-queue-snapshot.js';
export type { TaskQueueCounts } from './task-queue-snapshot.js';

// phase 1872 Step D: task 单条只读查询（assembly-async-task-storage-bypass 收口）
export { loadSubAgentTask } from './task-query.js';
// phase 1879 Step C: task result 目录存在性查询（results 命名空间布局归 owner）
export { resolveTaskResultDir } from './task-query.js';

// phase 1321: async-task-system 自有 stream 事件 const（分层拆件、恢复 1312 删的名）
export { STREAM_TASK_EVENTS } from './stream-events.js';
