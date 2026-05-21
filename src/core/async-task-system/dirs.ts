/**
 * AsyncTaskSystem 资源命名空间 const (M#3 single owner)
 *
 * phase 745 物理迁自 types/paths.ts — TASKS_QUEUES_RESULTS_DIR + TASKS_SUBAGENTS_DIR
 * phase 1105: re-export from foundation/paths for single source of truth
 */
export {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SYNC_DIR,
  TASKS_SUBAGENTS_DIR,
} from '../../foundation/paths.js';
