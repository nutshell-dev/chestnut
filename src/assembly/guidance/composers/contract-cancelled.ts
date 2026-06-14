/**
 * @module Assembly.GuidanceComposers
 * phase 63 γ NEW: contract_cancelled real composer
 * phase 190: 删 null 旁路、扩 batch 路径
 * phase 198: 精简到最小 state-driven CLI block（删事实段 + 系统已做 + 相关基础设施）
 *
 * 设计原则: state-driven CLI just-in-time 注入（仅省 motion 一步推理、不重灌 motion 已知静态知识）
 * - 事实段归 body（observer formatCancelled / safeNotify path）
 * - forensics 归 audit log
 * - 工具 / 路径静态清单归 motion-side chestnut-guide skill
 */

import { clawCmd, CLAW_VERBS, CONTRACT_COMMANDS } from '../../../cli/commands/registry.js';
import type { GuidanceComposer, GuidanceEntry } from '../types.js';

interface ContractCancelledState {
  source_claw?: string;
  contract_id?: string;
  reason?: string;
  cancellations?: string; // JSON-encoded array (observer 路径)
}

interface CancellationEntry {
  source_claw: string;
  contract_id: string;
  reason: string;
}

/**
 * Maximum cancelled contract batch render count（guidance composer 内 cancelled events 展示上限）.
 * Derivation: 10 batch ≈ 一次 guidance 可读取的 cancelled entry 数 / 平衡 prompt 完整 vs token 灌爆 /
 * 与 contract-crashed.ts MAX_BATCH_RENDER 同值同语义但 file-private（不抽 cross-file helper、playbook 否决）.
 */
const MAX_BATCH_RENDER = 10;

export const composer: GuidanceComposer<ContractCancelledState> = (state): GuidanceEntry | null => {
  const entries = parseEntries(state);
  if (entries.length === 0) {
    // phase 366 L3 (review-2026-06-13): state 缺关键字段时不渲染 '<unknown>' 字面 CLI block。
    // motion 可能真当合法命令调（'<unknown>' 不是 sentinel、是字面 string）。
    // 返 null 让 caller 跳过 emit。
    return null;
  }
  return { text: renderCliBlock(entries) };
};

function parseEntries(state: ContractCancelledState): CancellationEntry[] {
  // batch 路径优先
  if (state.cancellations) {
    try {
      const parsed = JSON.parse(state.cancellations) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((e): e is CancellationEntry =>
            typeof e === 'object' && e !== null &&
            typeof (e as Record<string, unknown>).source_claw === 'string' &&
            typeof (e as Record<string, unknown>).contract_id === 'string' &&
            typeof (e as Record<string, unknown>).reason === 'string'
          );
      }
    } catch {
      // silent: JSON parse failure handled by fallback to single-entry path below
    }
  }
  // single entry 路径（safeNotify）
  if (state.contract_id) {
    return [{
      source_claw: state.source_claw ?? '(unknown)',
      contract_id: state.contract_id,
      reason: state.reason ?? '(no reason given)',
    }];
  }
  return [];
}

function renderCliBlock(entries: CancellationEntry[]): string {
  const lines: string[] = [];
  const displayCount = Math.min(entries.length, MAX_BATCH_RENDER);
  if (entries.length > MAX_BATCH_RENDER) {
    lines.push(`(${entries.length} cancellations、显示前 ${MAX_BATCH_RENDER})`, ``);
  }
  for (const e of entries.slice(0, displayCount)) {
    lines.push(`${clawCmd(e.source_claw, CLAW_VERBS.TRACE)} --contract ${e.contract_id}`);
    lines.push(`${CONTRACT_COMMANDS.SHOW} -c ${e.source_claw} --contract ${e.contract_id}`);
  }
  return lines.join('\n');
}
