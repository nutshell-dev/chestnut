/**
 * callerType 字段值常量 — task.callerType 字段语义归属 SummonSystem。
 * AsyncTaskSystem 把 callerType 当 opaque string 中转、SummonSystem 是 canonical owner（M#3）。
 *
 * Phase 1396 Step K: 这些值仅用于 legacy v1/miner 任务的只读恢复兼容。
 * 新 summon 任务固定使用 SHADOW；不得再产生 MINER callerType。
 */
export const SUMMON_CALLER_TYPES = {
  SHADOW: 'shadow_subagent',
  /** Legacy v1 miner path; preserved only for recovering persisted miner tasks. */
  MINER: 'miner_subagent',
} as const;
