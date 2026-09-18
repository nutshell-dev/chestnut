/**
 * @module L4.SummonSystem.Types
 *
 * phase 1866 Step B（SU-D1）：Summon 装配依赖 typed options——位置参退役。
 *
 * 公开面只表达「goal/correlation 与结果」：调用方注入的是能力与来源事实，
 * 不是 shadow/subagent 的具体装配类（装配面归位见 tools/summon.ts 的复用裁定）。
 */

import type { ShortTaskId, SubAgentTask } from '../async-task-system/index.js';

/**
 * phase 1866 Step F（SU-D6）：Summon 消费的调度 capability——**summon 自有**声明，
 * 不是 ATS 的 `SubAgentTaskScheduler` 直穿。
 *
 * Summon 自己不构造任务载荷（提交动作归 shadow 装配 owner），只声明消费者视角的
 * 最小面：把一个 subagent 执行请求交给调度实现并取回任务 id。
 * ATS 实现宽赋窄（结构兼容，装配点零 cast）。
 */
export interface SummonSchedulerCapability {
  schedule(taskKind: 'subagent', payload: SummonExecutionRequest): Promise<ShortTaskId>;
}

/**
 * 执行请求：**ATS owner 的 typed 提交载荷**（summon 只透传给 shadow 装配面，不解释其字段）。
 *
 * 不是 ad-hoc `Record<string, unknown>`（phase 1358 ratchet：消费者必须用 owner 的 typed
 * 协议形状，不得自造无类型记录）——此处只把 owner 形状命名为 summon 视角的别名。
 */
export type SummonExecutionRequest = Omit<SubAgentTask, 'id' | 'shortId' | 'createdAt'>;

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
  scheduler?: SummonSchedulerCapability;
  correlation?: SummonCorrelation;
  allowFromShadow?: boolean;
}
