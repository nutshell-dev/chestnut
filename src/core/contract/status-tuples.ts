/**
 * @module L4.ContractSystem.StatusTuples
 * phase 358: status tuples 单源 — 解 phase 347 vs phase 348 物理放置导致 circular dep。
 *
 * 物理位置决策：
 * - phase 347: LIFECYCLE_PERSISTED_STATUSES_TUPLE 物理放 schemas.ts (与 z.enum 同 file)
 * - phase 348: DERIVABLE_STATUSES_TUPLE 物理放 types.ts (与 Set + type 同 file)
 * - phase 352: ALL_CONTRACT_STATUSES_TUPLE 合 2 base、物理放 types.ts
 * - phase 358: schemas.ts 需 ALL_CONTRACT_STATUSES_TUPLE narrow archive loose status enum →
 *   types.ts → schemas.ts (LIFECYCLE) + schemas.ts → types.ts (ALL) = circular。
 *   解: 把 3 个 status tuples 抽到本 file (0 dep on schemas/types)、两 file 都从此单向 import。
 *
 * ML#5 单向依赖 + ML#1 共用基础设施单源 + ML#8 耦合界面最小 + M#9 优先编译器检查。
 */

export const DERIVABLE_STATUSES_TUPLE = ['pending', 'running', 'completed'] as const;

/**
 * phase 362: SubtaskStatus tuple (mirror DERIVABLE/LIFECYCLE tuple pattern、ML#1 共用基础设施单源)
 * subtask 状态 = 'todo' | 'in_progress' | 'completed' (与 ContractStatus 独立、仅 'completed' literal 共享)
 */
export const SUBTASK_STATUSES_TUPLE = ['todo', 'in_progress', 'completed'] as const;

export const LIFECYCLE_PERSISTED_STATUSES_TUPLE = [
  'paused',                       // paused 子目录、用户主动暂停
  'cancelled',                    // archive 子目录、用户 CLI / system 主动停
  'crashed',                      // archive 子目录、agent 物理推不动 (phase 63)
  'archive_pending_recovery',     // archiveAndEmit partial recovery state (phase 1371 sub-2)
  'archive_corrupted',            // phase 951: archive-level corrupted marker (terminal)
] as const;

export const ALL_CONTRACT_STATUSES_TUPLE = [
  ...DERIVABLE_STATUSES_TUPLE,
  ...LIFECYCLE_PERSISTED_STATUSES_TUPLE,
] as const;
