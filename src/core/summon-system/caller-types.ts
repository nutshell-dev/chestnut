/**
 * callerType 字段值常量 — task.callerType 字段语义归属 SummonSystem。
 * AsyncTaskSystem 把 callerType 当 opaque string 中转、SummonSystem 是 canonical owner（M#3）。
 *
 * - SHADOW: spawn 子代理继承 caller 上下文（默认）
 * - MINER:  spawn 子代理空白起步、通过 ask_motion 多轮问答构建上下文
 */
export const SUMMON_CALLER_TYPES = {
  SHADOW: 'shadow',
  MINER: 'miner',
} as const;

export type SummonCallerType = typeof SUMMON_CALLER_TYPES[keyof typeof SUMMON_CALLER_TYPES];
