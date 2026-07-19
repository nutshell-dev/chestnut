/**
 * @module L4.ContractSystem.StatusTuples
 * phase 358: status tuples 单源 — 解 phase 347 vs phase 348 物理放置导致 circular dep。
 *
 * Step F: current lifecycle is path-derived; progress.json no longer carries lifecycle
 * status. Only the derivable aggregate subset and subtask statuses remain current.
 * Legacy flat-archive literals live in schemas.ts LEGACY_PROGRESS_STATUSES_TUPLE for
 * read-only historical parsing.
 */

export const DERIVABLE_STATUSES_TUPLE = ['pending', 'running', 'completed'] as const;

/**
 * phase 362: SubtaskStatus tuple (mirror DERIVABLE/LIFECYCLE tuple pattern、ML#1 共用基础设施单源)
 * subtask 状态 = 'todo' | 'in_progress' | 'completed' (与 DerivableStatus 独立、仅 'completed' literal 共享)
 */
export const SUBTASK_STATUSES_TUPLE = ['todo', 'in_progress', 'completed'] as const;

/**
 * Phase 1134: runtime subtask status vocabulary for the new active/current layout.
 * Distinct from the legacy SUBTASK_STATUSES_TUPLE which uses 'in_progress' naming.
 */
export const SUBTASK_RUNTIME_STATUSES_TUPLE = ['todo', 'verifying', 'completed'] as const;

/**
 * Phase 1134: verification attempt lifecycle vocabulary.
 */
export const VERIFICATION_ATTEMPT_STATUSES_TUPLE = [
  'running',
  'passed',
  'rejected',
  'interrupted',
] as const;
