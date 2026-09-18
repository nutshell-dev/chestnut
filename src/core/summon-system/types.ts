/**
 * @module L4.SummonSystem.Types
 *
 * phase 1866 Step B（SU-D1）：Summon 装配依赖 typed options——位置参退役。
 *
 * 公开面只表达「goal/correlation 与结果」：调用方注入的是能力与来源事实，
 * 不是 shadow/subagent 的具体装配类（装配面归位见 tools/summon.ts 的复用裁定）。
 */

import type { SubAgentTaskScheduler } from '../async-task-system/index.js';

/**
 * 创建链路的来源事实（caller/来源 claw identity）。
 *
 * 只作 correlation 记录（task origin），不参与执行裁决。
 */
export interface SummonCorrelation {
  readonly originClawId?: string;
}

/**
 * SummonTool 装配依赖。
 *
 * - `scheduler`：异步执行调度能力。缺省 = 无调度面（execute 经 shadow 装配面
 *   的 task_system_unavailable 早退，行为与旧 `undefined` 位置参一致）。
 *   phase 1866 Step F（SU-D6）将该字段类型收窄为 Summon 自有 capability。
 * - `correlation`：来源事实（旧第 2 位置参 `originClawId`）。
 * - `allowFromShadow`：shadow 调用防御（restricted registry 注入 false；
 *   旧第 3 位置参，缺省 true）。
 */
export interface SummonToolDeps {
  scheduler?: SubAgentTaskScheduler;
  correlation?: SummonCorrelation;
  allowFromShadow?: boolean;
}
