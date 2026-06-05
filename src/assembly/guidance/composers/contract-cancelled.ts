/**
 * @module Assembly.GuidanceComposers
 * phase 63 γ NEW: contract_cancelled real composer
 *
 * 触发：cancelContract 走 safeNotify 路径（motion 自家 cancel 自家 contract 实时）
 *      或 contract-observer cron 扫 worker archive 发现 cancelled contract
 *
 * 设计原则（Philosophy「系统为智能体服务、提供基础设施和必要信息」）：
 * - 事实 + 系统已尝试 + 相关基础设施
 * - 0 prescription（无「建议」「推荐」「应该」「按优先级」字面）
 * - motion 自决用哪条基础设施处理
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';

interface ContractCancelledState {
  source_claw?: string;
  contract_id?: string;
  reason?: string;
}

export const composer: GuidanceComposer<ContractCancelledState> = (state): GuidanceEntry | null => {
  // observer 路径无 extraFields、body 已自足 → 不追加 guidance
  if (!state.contract_id) return null;

  const sourceClaw = state.source_claw ?? '(unknown)';
  const contractId = state.contract_id ?? '(unknown)';
  const reason = state.reason ?? '(no reason given)';

  const lines: string[] = [
    `[contract_cancelled]`,
    ``,
    `事实:`,
    `  source_claw: ${sourceClaw}`,
    `  contract_id: ${contractId}`,
    `  reason:      ${reason}`,
    ``,
    `系统已做:`,
    `  - lockContract source dir`,
    `  - saveProgress(status='cancelled', checkpoint='cancelled: <reason>')`,
    `  - abortContractVerifiers (best-effort)`,
    `  - move source → archive`,
    `  - emit CONTRACT_CANCELLED audit`,
    ``,
    `相关基础设施:`,
    `  CLI:        chestnut contract [list|cancel]`,
    `  agent 工具: exec, ask_user, send, summon, notify_claw`,
    `  文件系统:   archive 下的 contract 目录可 read/inspect、含 progress.json + contract.yaml`,
  ];

  return { text: lines.join('\n') };
};
