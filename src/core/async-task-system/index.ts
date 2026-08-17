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
export { PersistentShortIdIndex } from './short-id-index.js';
export { validateTaskShape } from './task-corrupt-helpers.js';
export { ASYNC_TASK_SYSTEM_INBOX_MESSAGE_TYPES } from './inbox-formatter.js';
export type {
  SubAgentTask,
  PreparedSubagentSchedule,
  SubAgentTaskScheduler,
  PreparedSubAgentTaskScheduler,
  AsyncTaskRuntimeLifecycle,
  TaskId,
  FullTaskId,
  ShortTaskId,
  TaskIdResolver,
  ShortIdIndex,
} from './types.js';
export { makeShortTaskId, makeFullTaskId, makeTaskId, deriveShortIdFromTaskId } from './types.js';
export type { PostProcessor } from './post-processors/types.js';
export type { ProcessedTaskResult } from './result-delivery-types.js';

export {
  TASKS_SYNC_DIR,
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SUBAGENTS_DIR,
  TASK_SNAPSHOT_IGNORE,  // phase 693 Step B
  POST_PROCESS_INPUT_FILE,
  RESULT_META_FILE,
} from './dirs.js';

export { classifyTaskError } from './_helpers.js';

// phase 481: TASK_AUDIT_EVENTS barrel re-export
export { TASK_AUDIT_EVENTS } from './audit-events.js';
// phase 485: task-schemas type barrel re-export
export type { SummonDecisionMetadata } from './task-schemas.js';

// phase 1130: typed audit emit functions
// phase 1302: 32 个 emit* 符号在 src + tests 中经 barrel 消费全为 0；撤销 phase 132 wildcard。
// audit-emit.js 仍由模块内文件深链消费，barrel 不再对外 re-export。




// phase 843: migrated exec task query API
export { listMigratedExecTasks } from './list-migrated-exec.js';
export type { MigratedExecTaskInfo, TaskReadError } from './list-migrated-exec.js';

// phase 1321: async-task-system 自有 stream 事件 const（分层拆件、恢复 1312 删的名）
export { STREAM_TASK_EVENTS } from './stream-events.js';
