/**
 * @module L6.Assembly.Guidance
 * phase 2 γ4 → phase 201 → phase 1257 Step B:
 *   - 删 local wire interface / 本地 crash-class guard / claw-id placeholder fallback
 *   - composer 只消费 Watchdog owner codec 的 typed state（decodeClawCrashedGuidance）
 *   - 真实 envelope `from` 直接成为 CLI target（合法消息不再产生 placeholder）
 *   - unknown/malformed wire 由 decoder 抛 typed error → Runtime 写
 *     GUIDANCE_COMPOSER_FAILED 并仅投递原 body（不再产看似可执行的假命令）
 *
 * 业主 (watchdog) own CrashClass enum + wire schema + clean-stop marker 探测。
 * Assembly 此处 own motion-side CLI 教学：按 typed CrashClass exhaustive switch
 * 1 primary action per case (DP「相关」derive / 反 phase 1476 anti-pattern #5「多 options」).
 *
 * Sub-case 行为：
 *  - active_unexpected: 教 motion 重启 daemon (`chestnut claw <id> daemon`) + inspect (steps)
 *  - active_user_stopped: read-only inspect (status + steps)、不附 restart 暗示（保 design intent）
 *
 * codec import 仅限 watchdog/claw-crashed-guidance.ts 这一稳定 protocol 文件
 * （纯函数、零 Watchdog runtime resource），不放宽到 Watchdog 其他实现。
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { renderClawInvocation } from '../../../cli-protocol/index.js';
import { decodeClawCrashedGuidance } from '../../../watchdog/claw-crashed-guidance.js';


export const composer: GuidanceComposer = (input): GuidanceEntry => {
  const state = decodeClawCrashedGuidance(input);
  const id = state.clawId;
  switch (state.crashClass) {
    case 'active_unexpected':
      // phase 4: 2-line guidance — primary action (restart) + optional diagnostic (steps)
      // 不冲突 phase 1476 anti-pattern #5: restart vs steps 是 orthogonal (action vs investigation)、不是「motion 在等价选项中选 1」
      return {
        text: `To restart: ${renderClawInvocation(id, 'daemon')}\nTo inspect what the claw was doing before crash: ${renderClawInvocation(id, 'steps')}`,
      };
    case 'active_user_stopped':
      // phase 201: design intent「不暗示 restart」保留 → read-only inspect only
      return {
        text: `To check current status: ${renderClawInvocation(id, 'status')}\nTo inspect what the claw was doing: ${renderClawInvocation(id, 'steps')}`,
      };
    default: {
      const _exhaustive: never = state.crashClass;
      return _exhaustive;
    }
  }
};
