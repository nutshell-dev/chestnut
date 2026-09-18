/**
 * @module L4.SummonSystem.LegacyDecision
 *
 * phase 1866 Step C（SU-D2）：legacy `summonDecision` **读面**（migration 兼容解释层）。
 *
 * SoT 关系（创建 evidence 单一）：
 * - 创建事实 authority = creation claim（`creation-claim-store`）+ ContractSystem 核实；
 * - 本文件的 legacy decision 读**不是**第二 authority——它是已落盘 v1/v2 任务的
 *   migration 兼容输入（phase 1402 Step B 起 active writer 停写；1863 AT-D6 删除
 *   ATS 侧 legacy 写路径）；
 * - 回执（task result envelope）是**结果交付**、pending-retrospective 是**观测/补报**，
 *   两者都不构成创建 evidence。
 */

import type { SubAgentTask, LegacySummonDecisionV1 } from '../async-task-system/index.js';

/**
 * legacy decision 读结果（typed：解释面单一，policy 不再内联版本判断）。
 */
export type SummonDecisionRead =
  /** v1 legacy：保留 verify/targetClaw 行为的恢复兼容路径。 */
  | { readonly kind: 'legacy_v1'; readonly decision: LegacySummonDecisionV1 }
  /** v2 legacy：与当前 canonical 路径同行为（no-verification + ctx.clawDir executor）。 */
  | { readonly kind: 'legacy_v2' }
  /** 无 decision：当前 task 由 canonical postProcessor identity 识别，或非 summon 路径。 */
  | { readonly kind: 'absent' }
  /** 未知未来版本：fail-observable，绝不降级为 pass-through。 */
  | { readonly kind: 'unknown_schema_version'; readonly version: unknown };

/** 读 task metadata 的 legacy summon decision（纯函数、零 IO）。 */
export function readSummonDecision(task: Pick<SubAgentTask, 'summonDecision'>): SummonDecisionRead {
  const decision = task.summonDecision;
  if (!decision) return { kind: 'absent' };
  if (decision.schema_version === 1) return { kind: 'legacy_v1', decision };
  if (decision.schema_version === 2) return { kind: 'legacy_v2' };
  return {
    kind: 'unknown_schema_version',
    version: (decision as Record<string, unknown>).schema_version ?? 'missing',
  };
}
