// phase 471: constants barrel re-export
export {
  DEFAULT_MAX_CONCURRENT_TASKS,
  ASYNC_EXEC_SOFT_TIMEOUT_MS,
} from './constants.js';

/**
 * @module L4.AsyncTaskSystem
 * Task system exports
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import { AsyncTaskSystem } from './system.js';
import type { AsyncTaskSystemOptions } from './types.js';

export { AsyncTaskSystem } from './system.js';
export type { SubAgentTask, PreparedSubagentSchedule, TaskId, FullTaskId, ShortTaskId, ShortIdIndex } from './types.js';
export { makeShortTaskId, makeFullTaskId, makeTaskId, deriveShortIdFromTaskId } from './types.js';
export type { PostProcessor } from './post-processors/types.js';

export {
  TASKS_SYNC_DIR,
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SUBAGENTS_DIR,
  TASK_SNAPSHOT_IGNORE,  // phase 693 Step B
} from './dirs.js';

export { classifyTaskError } from './_helpers.js';

// phase 481: TASK_AUDIT_EVENTS barrel re-export
export { TASK_AUDIT_EVENTS } from './audit-events.js';
// phase 485: task-schemas type barrel re-export
export type { SummonDecisionMetadata } from './task-schemas.js';

// phase 1130: typed audit emit functions
// phase 1302: 32 个 emit* 符号在 src + tests 中经 barrel 消费全为 0；撤销 phase 132 wildcard。
// audit-emit.js 仍由模块内文件深链消费，barrel 不再对外 re-export。




/**
 * AsyncTaskSystem 工厂函数。签名与 constructor 1:1；纯透传不加工。
 *
 * 调用方：Assembly。
 * 不调 initialize / startDispatch——业务动作归 Runtime（见 l4_task_system.md §2 "#2 归属辨析"）。
 */
export function createAsyncTaskSystem(
  clawDir: string,
  fs: FileSystem,
  options: AsyncTaskSystemOptions,
): AsyncTaskSystem {
  return new AsyncTaskSystem(clawDir, fs, options);
}

// phase 843: migrated exec task query API
export { listMigratedExecTasks } from './list-migrated-exec.js';
export type { MigratedExecTaskInfo, TaskReadError } from './list-migrated-exec.js';
