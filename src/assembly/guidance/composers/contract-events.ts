/**
 * @module L6.Assembly.Guidance
 * phase 1469 立 / phase 1487 γ5 real composer 替 NO_GUIDANCE 占位.
 * phase 205 Step B: 3 旁路删 + 主路精简（state-driven CLI block）
 * phase 1261 Step B: 只消费 ContractSystem owner codec typed state —
 *   persisted state schema（v1 refs JSON 与两套 legacy dialect）、ID 规则与
 *   malformed 分类全部归 src/core/contract/contract-events-guidance.ts；
 *   本 composer 不再声明 Contract metadata interface、CSV parser 或 ID regex，
 *   decoder 坏 wire typed throw（Runtime catch 后 audit + 仅投递正文，
 *   不再逐项静默过滤）。
 *
 * composer 单一 logic：state-driven CLI block 出 trace + show per contract。
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { renderClawInvocation, CONTRACT_COMMANDS } from '../../../cli-protocol/index.js';
import {
  decodeContractEventsGuidance,
  type ContractEventGuidanceRef,
} from '../../../core/contract/index.js';

/**
 * Maximum claw-contract pair render count（guidance composer 内 contract events 展示上限）.
 * Derivation: 10 pair ≈ 一次 guidance refresh 可读取列表 / 平衡 prompt 完整 vs token 灌爆 /
 * 配合 audit footprint sample 同型经验值（FOOTPRINT_READS_TOP_N=20）/ 防 long event list 灌满 prompt.
 */
const MAX_PAIR_RENDER = 10;

export const composer: GuidanceComposer = (input): GuidanceEntry | null => {
  const { contractRefs } = decodeContractEventsGuidance(input);
  if (contractRefs.length === 0) {
    // phase 366 L3 (review-2026-06-13): 不渲染 '<unknown>' 字面 CLI block、返 null
    // phase 1261: observer 空 refs（正文覆盖全部 completed events、无失败契约）是合法 owner state
    return null;
  }
  return { text: renderCliBlock(contractRefs) };
};

function renderCliBlock(refs: readonly ContractEventGuidanceRef[]): string {
  const lines: string[] = [];
  const displayCount = Math.min(refs.length, MAX_PAIR_RENDER);
  if (refs.length > MAX_PAIR_RENDER) {
    lines.push(`(${refs.length} contract events、显示前 ${MAX_PAIR_RENDER})`, '');
  }
  for (const ref of refs.slice(0, displayCount)) {
    lines.push(`${renderClawInvocation(ref.clawId, 'trace')} --contract ${ref.contractId}`);
    lines.push(`${CONTRACT_COMMANDS.SHOW} -c ${ref.clawId} --contract ${ref.contractId}`);
  }
  return lines.join('\n');
}
