import { STREAM_FILE } from '../stream/index.js';
import { AUDIT_FILE } from '../audit/index.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_SUBAGENTS_DIR } from '../../types/paths.js';

/**
 * Snapshot 需要忽略的跨模块资源清单（消费侧定义）。
 * 新增需忽略的资源时，只改此处。
 */
export const SNAPSHOT_IGNORE_PATTERNS: readonly string[] = [
  STREAM_FILE,
  AUDIT_FILE,
  `${TASKS_QUEUES_RESULTS_DIR}/`,
  'tasks/sync/',
  `${TASKS_SUBAGENTS_DIR}/`,        // phase 512 / subagent workspace ephemeral / 不进 commit
];
