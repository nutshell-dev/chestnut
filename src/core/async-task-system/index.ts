/**
 * @module L4.AsyncTaskSystem
 * Task system exports
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import { AsyncTaskSystem, type AsyncTaskSystemOptions, type SubAgentTask } from './system.js';

export { AsyncTaskSystem, type SubAgentTask, type AsyncTaskSystemOptions } from './system.js';

export { TASKS_QUEUES_RESULTS_DIR, TASKS_SUBAGENTS_DIR } from './dirs.js';

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
