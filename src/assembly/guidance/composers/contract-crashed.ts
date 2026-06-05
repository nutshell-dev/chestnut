/**
 * @module Assembly.GuidanceComposers
 * phase 63 γ NEW: contract_crashed real composer
 *
 * 触发：markCrashed 走 safeNotify 路径（motion 自家 contract 执行 5 typed Error 之一）
 *      或 contract-observer cron 扫 worker archive 发现 crashed contract
 *
 * 设计原则（Philosophy「系统为智能体服务、提供基础设施和必要信息」）：
 * - 事实 + 系统已尝试 + 相关基础设施
 * - 0 prescription
 * - motion 自决 cancel + re-summon / 调研 backup / 询问 user / 调整 fork 策略
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';

interface ContractCrashedState {
  source_claw?: string;
  contract_id?: string;
  cause?: string;
}

export const composer: GuidanceComposer<ContractCrashedState> = (state): GuidanceEntry | null => {
  // observer 路径无 extraFields、body 已自足 → 不追加 guidance
  if (!state.contract_id) return null;

  const sourceClaw = state.source_claw ?? '(unknown)';
  const contractId = state.contract_id ?? '(unknown)';
  const cause = state.cause ?? '(no cause given)';

  const lines: string[] = [
    `[contract_crashed]`,
    ``,
    `事实:`,
    `  source_claw: ${sourceClaw}`,
    `  contract_id: ${contractId}`,
    `  cause:       ${cause}`,
    ``,
    `cause 字面格式: "system: <typed_error_class_name>"（如 system: maxstepsexceedederror）`,
    `  - 表示 agent loop / LLM provider 物理推不动该 contract`,
    `  - 非 user 主动决策、非 daemon crash（daemon 仍活着）`,
    ``,
    `系统已做:`,
    `  - Runtime catch 捕获 typed Error（max_steps / wall_time / parse_loop / max_tokens / llm_all_providers）`,
    `  - 从 inbox message metadata 取 contract_id`,
    `  - ContractSystem.markCrashed: lockContract + saveProgress(status='crashed') + abortContractVerifiers + move source → archive`,
    `  - emit CONTRACT_CRASHED audit`,
    ``,
    `相关基础设施:`,
    `  CLI:        chestnut contract [list|cancel|create]`,
    `  agent 工具: exec, ask_user, send, summon, notify_claw`,
    `  文件系统:   archive 下的 contract 目录可 read/inspect、含 progress.json (含 cause 在 checkpoint) + contract.yaml`,
  ];

  return { text: lines.join('\n') };
};
