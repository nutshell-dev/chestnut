/**
 * @module L6.Assembly.Guidance
 * phase 1469 立 / phase 1487 γ5 real composer 替 NO_GUIDANCE 占位.
 *
 * state schema（业主侧 wire / 详 sister design row）：
 *   - source_claw?: string   A3 path (assemble.ts:550 callback) 透传 = 当前 claw id
 *                            A4 path (observer) 不设 / 默认 != MOTION
 *   - problem_pairs?: string A4 path 聚合 `<claw>:<contract>` 逗号分隔（有 last_failure 的 entries）
 *                            A3 path 不设（thin body 无 subtask 信息）
 *
 * composer 单分支：
 *   (1) source_claw == MOTION_CLAW_ID → null (motion 自家、session 已含完整上下文 / DP「不冗余打扰」)
 *   (2) problem_pairs 空 → null (worker clean、body 内 evidence 路径已足 / DP「事件驱动恰好交付」)
 *   (3) 否则枚举 problem_pairs 每 pair 输出 `clawforum claw <实claw> trace <实contract>` + 推荐 shadow
 *
 * 应然 anchor (详 design/modules/l6_assembly.md A.phase1487-contract-events-composer-real):
 *   - DP「motion 是决策主体」: 去 [force-accepted] 字面 (event-collector.ts cleanup)
 *   - DP「事件驱动恰好交付」: 仅在 last_failure 时教 / clean 不打扰
 *   - Philosophy P2「上下文工程」: trace + shadow 工具知识 just-in-time 注入
 *   - ML#5 不预设上层: 业主仅 own state schema, Assembly 此处 own CLI 字面 + tool 名
 *   - ML#9 编译期 check: clawCmd + CLAW_VERBS.TRACE + TOOL_NAMES.SHADOW typed const
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { clawCmd, CLAW_VERBS } from '../../../cli/commands/registry.js';
import { TOOL_NAMES } from '../tool-names.js';
import { MOTION_CLAW_ID } from '../../../constants.js';

interface ContractEventsState {
  source_claw?: string;
  problem_pairs?: string;
}

export const composer: GuidanceComposer<ContractEventsState> = (state): GuidanceEntry | null => {
  // (1) motion own contract done → null
  if (state.source_claw === MOTION_CLAW_ID) {
    return null;
  }

  // (2) worker clean (no failure feedback) → null
  const pairs = (state.problem_pairs ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (pairs.length === 0) {
    return null;
  }

  // (3) enumerate trace commands for each problem (claw, contract) pair
  const traceLines: string[] = [];
  for (const pair of pairs) {
    const sepIdx = pair.indexOf(':');
    if (sepIdx <= 0 || sepIdx >= pair.length - 1) continue;  // malformed pair
    const claw = pair.slice(0, sepIdx);
    const contract = pair.slice(sepIdx + 1);
    traceLines.push(`${clawCmd(claw, CLAW_VERBS.TRACE)} ${contract}`);
  }
  if (traceLines.length === 0) {
    return null;
  }

  const intro = traceLines.length === 1
    ? '子任务提交但有 last_failure 记录。如需调查 claw 在该 contract 的执行轨迹，可用：'
    : `${traceLines.length} 个 contract 子任务提交但有 last_failure 记录。如需调查 claw 在该 contract 的执行轨迹，可用：`;

  const text = [
    intro,
    ...traceLines,
    `建议使用 ${TOOL_NAMES.SHADOW} 工具创建分身来进行调查。`,
  ].join('\n');

  return { text };
};
