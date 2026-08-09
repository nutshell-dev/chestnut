/**
 * @module L6.Assembly.Guidance.Bindings
 * phase 1264 Step A: `claw_inactivity` Assembly typed binding（第二个 CLI guidance 纵向切片）。
 *
 * 职责边界（M#1/M#2）：
 * - 业主 (watchdog) own FailureClass enum + wire schema + codec（claw-inactivity-guidance.ts）；
 * - CLIProtocol own action vocabulary、label/layout 与最终渲染；
 * - 本 binding 是装配知识：只做 exhaustive `FailureClass → CliGuidanceDocument` 选择，
 *   不产 prose、CLI literal 或最终 entry（旧 composer 自由文本职责移交 CLIProtocol）。
 *
 * 行为保持（phase 2 γ4 / phase 4 / phase 5 design intent 不变）：
 *  - daemon_silent: inspect-stuck (steps) + watch-after-intervention (watch 5m)
 *  - daemon_errored: inspect (steps) + watch-after-intervention (watch 5m)
 * target 取 owner state 的真实 clawId（envelope from 固定 watchdog = 发起模块业务语义）；
 * `inactiveAfter: '5m'` 是 typed action value（cross-protocol adapter 的最小信息），
 * option identity/syntax 与渲染仍归 CLIProtocol。
 *
 * decoder typed throw 原样穿透 register helper → Runtime GUIDANCE_COMPOSER_FAILED
 * audit 与正文保留链不变（本 phase 不改失败链）。不参与 affordance 的 owner facts
 * （inactive 时长 / contract / as-of / subscription 触发 / 最近错误）不跨边界。
 *
 * import 仅限两侧稳定 protocol：Watchdog owner codec 纯函数文件 +
 * CLIProtocol public barrel；不 import GuidanceComposer/GuidanceEntry/registry。
 */

import { defineCliGuidanceBinding } from '../../../cli-protocol/index.js';
import { decodeClawInactivityGuidance } from '../../../watchdog/index.js';

export const clawInactivityGuidanceBinding = defineCliGuidanceBinding({
  type: 'claw_inactivity',
  decode: decodeClawInactivityGuidance,
  toDocument(state) {
    const target = { kind: 'claw', id: state.clawId } as const;
    const inspect = (() => {
      switch (state.failureClass) {
        case 'daemon_silent':
          // phase 4: stuck 诊断行（无 restart — daemon 还活着不该 restart）
          return { label: 'inspect-stuck', action: { kind: 'claw.steps', target } } as const;
        case 'daemon_errored':
          return { label: 'inspect', action: { kind: 'claw.steps', target } } as const;
        default: {
          const exhaustive: never = state.failureClass;
          return exhaustive;
        }
      }
    })();
    return {
      lines: [
        inspect,
        // phase 5: motion 干预后若仍 stuck 主动订阅再提醒（两行固定、跨 FailureClass 共享）
        {
          label: 'watch-after-intervention',
          action: { kind: 'claw.watch', target, inactiveAfter: '5m' },
        },
      ],
    };
  },
});
