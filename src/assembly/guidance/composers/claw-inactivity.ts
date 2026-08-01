/**
 * @module L6.Assembly.Guidance
 * phase 1482 γ3 → phase 201 → phase 1258 Step B:
 *   - composer 只经 Watchdog owner codec (claw-inactivity-guidance.ts) 取 typed state；
 *   - unknown class / 空 claw id / malformed wire 由 decoder 抛 typed error，
 *     进入 Runtime GUIDANCE_COMPOSER_FAILED audit 路径（fallback inspect 与
 *     claw-id placeholder 退役）；
 *
 * 业主 (watchdog) own FailureClass enum + base body 字面 + wire schema/version。
 * Assembly 此处 own motion-side CLI 教学：按 enum exhaustive switch 1 primary action
 * per case (DP「相关」derive / 反 phase 1476 anti-pattern #5 「多 options」).
 *
 * State 接 via Runtime extraMeta wire (watchdog-log.ts writeClawInactivityInbox
 * owner codec extraFields → encodeInbox YAML → 收件方 extraMeta → decoder)。
 *
 * 业主类型 FailureClass type-only import；owner codec 纯函数 runtime import
 * (peer L6↔L6 装配综合本职、不违 M#5；codec 零 Watchdog runtime resource)。
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { renderClawInvocation } from '../../../cli-protocol/index.js';
import type { FailureClass } from '../../../watchdog/claw-failure-classes.js';
import { decodeClawInactivityGuidance } from '../../../watchdog/claw-inactivity-guidance.js';


// phase 2 γ4: daemon_stopped case 移除（归 claw_crashed composer 覆盖、两 type 互斥状态 0 dedup 重叠）
// phase 4: guidance 字面统一英文 / 简化 = 单 CLI line (diagnostic only, 无 restart — daemon 还活着不该 restart)
// phase 5: 加 watch subscription CLI 教学 (motion 干预后若仍 stuck 主动订阅再提醒 / DP 系统为智能体服务)
// phase 1258 Step B: 不再声明 wire key/guard/fallback — typed state 经 decoder，unknown 不再可达
export const composer: GuidanceComposer = (input): GuidanceEntry => {
  const state = decodeClawInactivityGuidance(input);
  const inspect = renderKnownInspect(state.failureClass, state.clawId);
  const watch = `To be notified if it remains stuck after intervention: ${renderClawInvocation(state.clawId, 'watch')} --inactive-after 5m`;
  return { text: `${inspect}\n${watch}` };
};

function renderKnownInspect(cls: FailureClass, id: string): string {
  switch (cls) {
    case 'daemon_silent':
      return `To inspect what the agent is stuck on: ${renderClawInvocation(id, 'steps')}`;
    case 'daemon_errored':
      return `To inspect: ${renderClawInvocation(id, 'steps')}`;
    default: {
      const _exhaustive: never = cls;
      return _exhaustive;
    }
  }
}
