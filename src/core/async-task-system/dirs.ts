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

// Phase 1396 Step J: durable post-process input + authoritative outcome envelope
export const POST_PROCESS_INPUT_FILE = 'post-process-input.json' as const;
// Phase 1396 Step L: legacy Step J read-only (recovery migration); new writer is RESULT_ENVELOPE_FILE
export const RESULT_META_FILE = 'result-meta.json' as const;
// Phase 1396 Step L: single-file authoritative final outcome (processed-result-store owner)
export const RESULT_ENVELOPE_FILE = 'result-envelope.json' as const;
// phase 693 Step A: async-task 模块声明自家 ephemeral 资源 ignore list (M#3 single owner)
// Assembly 装配期 aggregate 各 owner 声明、注入 Snapshot ctor (per architecture §29)
// 用 dir prefix (trailing /) 形态：snapshot 按 dir 整忽略、与既有 TASKS_QUEUES_* (完整 path) 互补不重复
// phase 1489 Step B: tasks/sync/ 移出，由 Assembly 用 ClawIdentity 名称组合为跨 owner policy。
// phase 1490 Step B: tasks/subagents ignore 移出，归 SubAgent（其 canonical owner）声明。
export const TASK_SNAPSHOT_IGNORE: readonly string[] = [
  'tasks/queues/',
];
