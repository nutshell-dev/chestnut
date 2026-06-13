/**
 * @module L6.Assembly.Guidance
 * phase 1469 立 / phase 1487 γ5 real composer 替 NO_GUIDANCE 占位.
 * phase 205 Step B: 3 旁路删 + 主路精简（state-driven CLI block）
 *
 * state schema（业主侧 wire）：
 *   - source_claw?: string   A3 path (assemble.ts:550 callback) 透传 = 当前 claw id
 *   - contract_id?: string   A3 path extraFields（Step A 补）
 *   - problem_pairs?: string A4 path 聚合 `<claw>:<contract>` 逗号分隔（有 last_failure 的 entries）
 *
 * composer 单一 logic：state-driven CLI block 出 trace + show per contract。
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { clawCmd, CLAW_VERBS, CONTRACT_COMMANDS } from '../../../cli/commands/registry.js';

interface ContractEventsState {
  source_claw?: string;
  contract_id?: string;
  problem_pairs?: string;
}

interface ContractPair {
  claw: string;
  contract: string;
}

/**
 * Maximum claw-contract pair render count（guidance composer 内 contract events 展示上限）.
 * Derivation: 10 pair ≈ 一次 guidance refresh 可读取列表 / 平衡 prompt 完整 vs token 灌爆 /
 * 配合 audit footprint sample 同型经验值（FOOTPRINT_READS_TOP_N=20）/ 防 long event list 灌满 prompt.
 */
const MAX_PAIR_RENDER = 10;

// phase 324 H11: 严格 id 字符集、拒含 `:` `,` `` ` `` `\n` 等可注入 CLI / markdown 的字符。
// 上下游一致：producer (contract-observer) + consumer (本 composer) 都校验、防单边漏。
const ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function isValidId(s: string): boolean {
  return ID_REGEX.test(s);
}

export const composer: GuidanceComposer<ContractEventsState> = (state): GuidanceEntry => {
  const pairs = parsePairs(state);
  return { text: renderCliBlock(pairs) };
};

function parsePairs(state: ContractEventsState): ContractPair[] {
  // A4 observer 路径：problem_pairs CSV、每 pair `<claw>:<contract>`
  if (state.problem_pairs) {
    return state.problem_pairs
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(pair => {
        const sepIdx = pair.indexOf(':');
        if (sepIdx <= 0 || sepIdx >= pair.length - 1) return null;
        const claw = pair.slice(0, sepIdx);
        const contract = pair.slice(sepIdx + 1);
        // phase 324 H11: 拒含非法字符的 id（防 contract id 嵌 `:` 伪造额外 pair / 注入 motion prompt）
        if (!isValidId(claw) || !isValidId(contract)) return null;
        return { claw, contract };
      })
      .filter((p): p is ContractPair => p !== null);
  }
  // A3 path：single source_claw + contract_id
  if (state.source_claw && state.contract_id
    && isValidId(state.source_claw) && isValidId(state.contract_id)) {
    return [{ claw: state.source_claw, contract: state.contract_id }];
  }
  return [];
}

function renderCliBlock(pairs: ContractPair[]): string {
  if (pairs.length === 0) {
    // 兜底：state 缺关键字段、出 `<unknown>` 占位 CLI 模板（与 phase 198 cancelled/crashed 同 pattern）
    return [
      `${clawCmd('<unknown>', CLAW_VERBS.TRACE)} --contract <unknown>`,
      `${CONTRACT_COMMANDS.SHOW} -c <unknown> --contract <unknown>`,
    ].join('\n');
  }
  const lines: string[] = [];
  const displayCount = Math.min(pairs.length, MAX_PAIR_RENDER);
  if (pairs.length > MAX_PAIR_RENDER) {
    lines.push(`(${pairs.length} contract events、显示前 ${MAX_PAIR_RENDER})`, '');
  }
  for (const p of pairs.slice(0, displayCount)) {
    lines.push(`${clawCmd(p.claw, CLAW_VERBS.TRACE)} --contract ${p.contract}`);
    lines.push(`${CONTRACT_COMMANDS.SHOW} -c ${p.claw} --contract ${p.contract}`);
  }
  return lines.join('\n');
}
