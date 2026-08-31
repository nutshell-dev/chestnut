/**
 * @module L6.Assembly.Guidance.Bindings
 * phase 1265 Step A: `claw_outbox_summary` Assembly typed binding（第三个 CLI guidance 纵向切片）。
 *
 * 职责边界（M#1/M#2）：
 * - 业主 (core/claw-topology/jobs/outbox-summary) own persisted summary facts +
 *   wire schema + codec（guidance-state.ts）；
 * - CLIProtocol own action vocabulary、placeholder 语法、label/layout 与最终渲染；
 * - 本 binding 是装配知识：只做 `totalMsgs → 单个 placeholder outbox affordance`
 *   选择，不产 prose、CLI literal 或最终 entry（旧 composer 自由文本职责移交
 *   CLIProtocol）。
 *
 * 呈现策略保持（phase 1476 γ2 显式 decision，本 phase 不改）：target 是
 * `placeholder` discriminant（不是普通 claw id 字符串），limit 取 owner state
 * 的真实总消息数；motion 按 body 中 breakdown 自行选择具体目标。owner state
 * 无 discriminated business union，故无 exhaustive switch（编译器已检查
 * typed interface 与 action shape）。
 *
 * decoder typed throw 原样穿透 register helper → Runtime GUIDANCE_COMPOSER_FAILED
 * audit 与正文保留链不变（本 phase 不改失败链）。不参与 affordance 的 owner
 * facts 不跨边界（完整记录仍在 owner persisted metadata/body，不是丢失）。
 *
 * import 仅限两侧稳定 protocol：ClawTopology owner codec 纯函数文件 +
 * CLIProtocol public barrel；不 import GuidanceComposer/GuidanceEntry/registry。
 */

import { defineCliGuidanceBinding, type CliGuidanceBinding } from '../../../cli-protocol/index.js';
import { decodeOutboxSummaryGuidance } from '../../../core/claw-topology/index.js';

/**
 * owner decoded state 类型（Phase 1678 Step F：owner interface 已 localize 不可跨模块命名，
 * 经公开 decode 函数返回推导；本 exported const 的 declaration emit 需可命名类型）。
 */
type OutboxSummaryGuidanceDecodedState = ReturnType<typeof decodeOutboxSummaryGuidance>;

export const clawOutboxSummaryGuidanceBinding: CliGuidanceBinding<OutboxSummaryGuidanceDecodedState> = defineCliGuidanceBinding({
  type: 'claw_outbox_summary',
  decode: decodeOutboxSummaryGuidance,
  toDocument(state) {
    return {
      lines: [
        {
          label: 'read-outbox',
          action: {
            kind: 'claw.outbox',
            target: { kind: 'placeholder', name: 'claw-id' },
            limit: state.totalMsgs,
          },
        },
      ],
    };
  },
});
