/**
 * @module L6.Assembly.Guidance.Bindings
 * phase 1265 Step A: `claw_outbox_summary` Assembly typed binding（第三个 CLI guidance 纵向切片）。
 *
 * 职责边界（M#1/M#2）：
 * - 业主 (core/claw-topology/jobs/outbox-summary) own persisted summary facts +
 *   wire schema + codec（guidance-state.ts）；
 * - CLIProtocol own action vocabulary、label 自然语言 presentation 与最终渲染；
 * - 本 binding 是装配知识：只做 `counts → 逐 claw typed outbox affordance` 映射，
 *   不产 prose、CLI literal 或最终 entry（旧 composer 自由文本职责移交
 *   CLIProtocol）。
 *
 * 呈现策略（phase 1834，取代 phase 1476 γ2 的单占位 decision）：逐 claw 产出真实
 * target 与各自 limit —— counts 是 owner 持久化且 decoder 校验过的观察事实，
 * 逐 claw 映射让 motion 获得与正文一致的具体读取入口；limit 是该 claw 扫描时
 * 未读数（上限语义由 CLIProtocol 标签说明，不绑定读取时刻的消息集合）。
 * 排序与正文逐 claw 行一致（claw id localeCompare）。owner state 无
 * discriminated business union，故无 exhaustive switch（编译器已检查 typed
 * interface 与 action shape）。
 *
 * decoder typed throw 原样穿透 register helper → Runtime GUIDANCE_COMPOSER_FAILED
 * audit 与正文保留链不变（本 phase 不改失败链）。不参与 affordance 的 owner
 * facts 不跨边界（完整记录仍在 owner persisted metadata/body，不是丢失）。
 *
 * import 仅限两侧稳定 protocol：ClawTopology owner codec 纯函数文件 +
 * CLIProtocol public barrel；不 import GuidanceComposer/GuidanceEntry/registry。
 */

import { defineCliGuidanceBinding, type CliGuidanceBinding } from '../../../cli-protocol/index.js';
import {
  decodeOutboxSummaryGuidance,
  type OutboxSummaryGuidanceState,
} from '../../../core/claw-topology/index.js';

export const clawOutboxSummaryGuidanceBinding: CliGuidanceBinding<OutboxSummaryGuidanceState> = defineCliGuidanceBinding({
  type: 'claw_outbox_summary',
  decode: decodeOutboxSummaryGuidance,
  toDocument(state) {
    return {
      lines: Object.entries(state.counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, count]) => ({
          label: 'read-outbox' as const,
          action: {
            kind: 'claw.outbox' as const,
            target: { kind: 'claw' as const, id },
            limit: count,
          },
        })),
    };
  },
});
