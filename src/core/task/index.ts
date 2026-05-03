/**
 * @module L4.TaskSystem
 * Task system exports
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import { TaskSystem, type TaskSystemOptions, type SubAgentTask } from './system.js';

export { TaskSystem, type SubAgentTask, type TaskSystemOptions } from './system.js';

/** SubAgent task scheduling payload (sans id/createdAt, filled by writer) */
export type SubAgentTaskInfo = Omit<SubAgentTask, 'id' | 'createdAt'>;

/**
 * TaskSystem 工厂函数。签名与 constructor 1:1；纯透传不加工。
 *
 * 调用方：Assembly（phase158 Step 4 起）。
 * 不调 initialize / startDispatch——业务动作归 Runtime（见 l4_task_system.md §2 "#2 归属辨析"）。
 */
export function createTaskSystem(
  clawDir: string,
  fs: FileSystem,
  options: TaskSystemOptions,
): TaskSystem {
  return new TaskSystem(clawDir, fs, options);
}
