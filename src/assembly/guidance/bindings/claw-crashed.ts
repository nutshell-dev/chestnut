/**
 * @module L6.Assembly.Guidance.Bindings
 * phase 1263 Step C: `claw_crashed` Assembly typed binding（首个 CLI guidance 纵向切片）。
 *
 * 职责边界（M#1/M#2）：
 * - 业主 (watchdog) own CrashClass enum + wire schema + codec（claw-crashed-guidance.ts）；
 * - CLIProtocol own action vocabulary、label/layout 与最终渲染；
 * - 本 binding 是装配知识：只做 exhaustive `CrashClass → CliGuidanceDocument` 选择，
 *   不产 prose、CLI literal 或最终 entry（旧 composer 自由文本职责移交 CLIProtocol）。
 *
 * 行为保持（phase 4 / phase 201 design intent 不变）：
 *  - active_unexpected: restart (daemon) + inspect-before-crash (steps)
 *  - active_user_stopped: read-only inspect (status + steps)、不附 restart 暗示
 *
 * decoder typed throw 原样穿透 register helper → Runtime GUIDANCE_COMPOSER_FAILED
 * audit 与正文保留链不变（本 phase 不改失败链）。
 *
 * import 仅限两侧稳定 protocol：Watchdog owner codec 纯函数文件 +
 * CLIProtocol public barrel；不 import GuidanceComposer/GuidanceEntry/registry。
 */

import { defineCliGuidanceBinding } from '../../../cli-protocol/index.js';
import { decodeClawCrashedGuidance } from '../../../watchdog/index.js';

export const clawCrashedGuidanceBinding = defineCliGuidanceBinding({
  type: 'claw_crashed',
  decode: decodeClawCrashedGuidance,
  toDocument(state) {
    const target = { kind: 'claw', id: state.clawId } as const;
    switch (state.crashClass) {
      case 'active_unexpected':
        // phase 4: primary action (restart) + orthogonal diagnostic (steps)
        return {
          lines: [
            { label: 'restart', action: { kind: 'claw.daemon', target } },
            { label: 'inspect-before-crash', action: { kind: 'claw.steps', target } },
          ],
        };
      case 'active_user_stopped':
        // phase 201: design intent「不暗示 restart」保留 → read-only inspect only
        return {
          lines: [
            { label: 'check-current-status', action: { kind: 'claw.status', target } },
            { label: 'inspect-current-work', action: { kind: 'claw.steps', target } },
          ],
        };
      default: {
        const exhaustive: never = state.crashClass;
        return exhaustive;
      }
    }
  },
});
