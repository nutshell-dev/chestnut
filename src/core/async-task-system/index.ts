/**
 * @module L4.AsyncTaskSystem
 * Task system exports
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import { AsyncTaskSystem, type AsyncTaskSystemOptions, type SubAgentTask } from './system.js';

export { AsyncTaskSystem, type SubAgentTask, type AsyncTaskSystemOptions } from './system.js';

export {
  TASKS_SYNC_DIR,
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SUBAGENTS_DIR,
} from './dirs.js';

// phase 763：升级 pending writer 为公开 API / 修 evolution-system + assembly deep import 违 M#7
export { writePendingSubagentTaskFile } from './tools/_pending-task-writer.js';
export { writePendingToolTaskFile } from './tools/_pending-tool-task-writer.js';

/** SubAgent task scheduling payload (sans id/createdAt, filled by writer) */
export type SubAgentTaskInfo = Omit<SubAgentTask, 'id' | 'createdAt'>;

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
