// src/core/agent-executor/defaults.ts
/**
 * AgentExecutor 模块行为默认值 const
 * phase 747 物理迁自 src/constants.ts、M#3 资源唯一归属合规
 * mirror phase 745 dirs.ts 加 phase 746 dirs.ts 模板（owner module barrel 模板 N=3）
 *
 * DEFAULT_MAX_STEPS = ReAct loop 步数上限默认值
 * 由 config boundary（zod schema + assemble + init）resolve、其他 caller ctor required
 */
export const DEFAULT_MAX_STEPS = 1000;
