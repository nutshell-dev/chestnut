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
export type { AsyncTaskSystemOptions, SubAgentTask } from './types.js';
export type { AsyncExecWrapperParams } from './async-exec-wrapper.js';

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
// phase 132 M#8 ratify: wildcard export * by-design、20 个 emit* 中 18 个目前 cross-module 0-caller、保 wildcard M#7 模块对外承诺扩张策略优先 M#8、未来若大量 0-caller cluster 浮出可议改显式 list
export * from './audit-emit.js';




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
export type { MigratedExecTaskInfo, TaskReadError, MigratedExecListResult } from './list-migrated-exec.js';
