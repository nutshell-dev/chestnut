/**
 * @module L6.Assembly.GuidanceComposers.ContractCancelled
 * phase 63 γ NEW: contract_cancelled real composer
 * phase 190: 删 null 旁路、扩 batch 路径
 * phase 198: 精简到最小 state-driven CLI block（删事实段 + 系统已做 + 相关基础设施）
 * phase 1262 Step B: 只消费 ContractSystem owner codec typed state —
 *   persisted state schema（v1 refs JSON 与两套 legacy dialect）、ID 规则与
 *   malformed 分类全部归 src/core/contract/contract-cancelled-guidance.ts；
 *   本 composer 不再声明 Contract metadata interface、raw JSON parser、逐项静默
 *   过滤、fallback 或伪默认占位符；
 *   decoder 坏 wire typed throw（Runtime catch 后 audit + 仅投递正文）。
 *   decoder 保证 refs non-empty，composer 不再有 null path。
 *   超 cap 提示文案同步去 legacy wire key 字面（cancelled contracts、显示前 10）。
 *
 * 设计原则: state-driven CLI just-in-time 注入（仅省 motion 一步推理、不重灌 motion 已知静态知识）
 * - 事实段归 body（observer formatCancelled / safeNotify path）
 * - forensics 归 audit log
 * - 工具 / 路径静态清单归 motion-side chestnut-guide skill
 */

import { renderClawInvocation, CONTRACT_COMMANDS } from '../../../cli-protocol/index.js';
import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import {
  decodeContractCancelledGuidance,
  type ContractCancelledGuidanceRef,
} from '../../../core/contract/index.js';

/**
 * Maximum cancelled contract batch render count（guidance composer 内 cancelled events 展示上限）.
 * Derivation: 10 batch ≈ 一次 guidance 可读取的 cancelled entry 数 / 平衡 prompt 完整 vs token 灌爆 /
 * 与 contract-crashed.ts MAX_BATCH_RENDER 同值同语义但 file-private（不抽 cross-file helper、playbook 否决）.
 */
const MAX_BATCH_RENDER = 10;

export const composer: GuidanceComposer = (input): GuidanceEntry => {
  const { contractRefs } = decodeContractCancelledGuidance(input);
  return { text: renderCliBlock(contractRefs) };
};

function renderCliBlock(refs: readonly ContractCancelledGuidanceRef[]): string {
  const lines: string[] = [];
  const displayCount = Math.min(refs.length, MAX_BATCH_RENDER);
  if (refs.length > MAX_BATCH_RENDER) {
    lines.push(`(${refs.length} cancelled contracts、显示前 ${MAX_BATCH_RENDER})`, ``);
  }
  for (const ref of refs.slice(0, displayCount)) {
    lines.push(`${renderClawInvocation(ref.clawId, 'trace')} --contract ${ref.contractId}`);
    lines.push(`${CONTRACT_COMMANDS.SHOW} -c ${ref.clawId} --contract ${ref.contractId}`);
  }
  return lines.join('\n');
}
