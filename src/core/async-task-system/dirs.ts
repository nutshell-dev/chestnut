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
export { TASKS_SUBAGENTS_DIR } from '../subagent/constants.js';
