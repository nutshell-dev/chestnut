/**
 * AsyncTaskSystem 资源命名空间 const (M#3 single owner)
 *
 * Canonical owner of task queue path constants per M#3.
 * Previously re-exported from foundation/paths.ts (phase 1105),
 * which violated M#5 (foundation knowing about L4 task concepts).
 * Now defined inline as canonical source.
 */

export const TASKS_QUEUES_PENDING_DIR = 'tasks/queues/pending' as const;
export const TASKS_QUEUES_RUNNING_DIR = 'tasks/queues/running' as const;
export const TASKS_QUEUES_DONE_DIR = 'tasks/queues/done' as const;
export const TASKS_QUEUES_FAILED_DIR = 'tasks/queues/failed' as const;
export const TASKS_QUEUES_RESULTS_DIR = 'tasks/queues/results' as const;
export const TASKS_SYNC_DIR = 'tasks/sync' as const;
// phase 691 Step C: 改走 subagent barrel（cycle 已治、L3 SubAgent 不再反向 import L4 AsyncTaskSystem）
export { TASKS_SUBAGENTS_DIR } from '../subagent/index.js';

// phase 693 Step A: async-task 模块声明自家 ephemeral 资源 ignore list (M#3 single owner)
// Assembly 装配期 aggregate 各 owner 声明、注入 Snapshot ctor (per architecture §29)
// 用 dir prefix (trailing /) 形态：snapshot 按 dir 整忽略、与既有 TASKS_QUEUES_* (完整 path) 互补不重复
export const TASK_SNAPSHOT_IGNORE: readonly string[] = [
  'tasks/queues/',
  'tasks/sync/',
  'tasks/subagents/',
];
