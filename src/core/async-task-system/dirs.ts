/**
 * AsyncTaskSystem 资源命名空间 const (M#3 single owner)
 *
 * phase 745 物理迁自 types/paths.ts — TASKS_QUEUES_RESULTS_DIR + TASKS_SUBAGENTS_DIR
 * phase TBD 物理迁自 foundation/paths.ts — TASKS_QUEUES_{PENDING,RUNNING,DONE,FAILED}_DIR
 */
export const TASKS_QUEUES_PENDING_DIR = 'tasks/queues/pending';
export const TASKS_QUEUES_RUNNING_DIR = 'tasks/queues/running';
export const TASKS_QUEUES_DONE_DIR = 'tasks/queues/done';
export const TASKS_QUEUES_FAILED_DIR = 'tasks/queues/failed';
export const TASKS_SYNC_DIR = 'tasks/sync';
export const TASKS_QUEUES_RESULTS_DIR = 'tasks/queues/results' as const;
export { TASKS_SUBAGENTS_DIR } from '../subagent/constants.js';
