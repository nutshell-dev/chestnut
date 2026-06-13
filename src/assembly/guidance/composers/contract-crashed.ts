/**
 * @module Assembly.GuidanceComposers
 * phase 63 γ NEW: contract_crashed real composer
 * phase 191: 删 null 旁路、扩 batch 路径
 * phase 198: 精简到最小 state-driven CLI block（删事实段 + 系统已做 + 相关基础设施 + CAUSE_FORMAT_NOTE）
 *
 * 设计原则: state-driven CLI just-in-time 注入（仅省 motion 一步推理、不重灌 motion 已知静态知识）
 * - 事实段归 body（observer formatCrashed / safeNotify path）
 * - forensics 归 audit log
 * - 工具 / 路径静态清单归 motion-side chestnut-guide skill
 */

import { clawCmd, CLAW_VERBS, CONTRACT_COMMANDS } from '../../../cli/commands/registry.js';
import type { GuidanceComposer, GuidanceEntry } from '../types.js';

interface ContractCrashedState {
  source_claw?: string;
  contract_id?: string;
  cause?: string;
  crashes?: string; // JSON-encoded array (observer 路径)
}

interface CrashEntry {
  source_claw: string;
  contract_id: string;
  cause: string;
}

/**
 * Maximum crashed contract batch render count（guidance composer 内 crashed events 展示上限）.
 * Derivation: 10 batch ≈ 一次 guidance 可读取的 crashed entry 数 / 平衡 prompt 完整 vs token 灌爆 /
 * 与 contract-cancelled.ts MAX_BATCH_RENDER 同值同语义但 file-private（不抽 cross-file helper、playbook 否决）.
 */
const MAX_BATCH_RENDER = 10;

export const composer: GuidanceComposer<ContractCrashedState> = (state): GuidanceEntry => {
  const entries = parseEntries(state);
  if (entries.length === 0) {
    return { text: renderCliBlock([{ source_claw: '<unknown>', contract_id: '<unknown>', cause: '<unknown>' }]) };
  }
  return { text: renderCliBlock(entries) };
};

function parseEntries(state: ContractCrashedState): CrashEntry[] {
  // batch 路径优先
  if (state.crashes) {
    try {
      const parsed = JSON.parse(state.crashes) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((e): e is CrashEntry =>
            typeof e === 'object' && e !== null &&
            typeof (e as Record<string, unknown>).source_claw === 'string' &&
            typeof (e as Record<string, unknown>).contract_id === 'string' &&
            typeof (e as Record<string, unknown>).cause === 'string'
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
      cause: state.cause ?? '(no cause given)',
    }];
  }
  return [];
}

function renderCliBlock(entries: CrashEntry[]): string {
  const lines: string[] = [];
  const displayCount = Math.min(entries.length, MAX_BATCH_RENDER);
  if (entries.length > MAX_BATCH_RENDER) {
    lines.push(`(${entries.length} crashes、显示前 ${MAX_BATCH_RENDER})`, ``);
  }
  for (const e of entries.slice(0, displayCount)) {
    lines.push(`${clawCmd(e.source_claw, CLAW_VERBS.TRACE)} --contract ${e.contract_id}`);
    lines.push(`${CONTRACT_COMMANDS.SHOW} -c ${e.source_claw} --contract ${e.contract_id}`);
  }
  return lines.join('\n');
}
