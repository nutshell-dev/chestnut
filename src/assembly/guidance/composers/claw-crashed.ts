/**
 * @module L6.Assembly.Guidance
 * phase 2 γ4 → phase 201:
 *   - 删 unknown / user_stopped null 旁路
 *   - active_user_stopped 改 read-only inspect (status + steps)、保 design intent「不附 restart 暗示」
 *   - unknown 走 fallback inspect (steps)（不静默吞）
 *
 * 业主 (watchdog) own CrashClass enum + base body 字面 + clean-stop marker 探测。
 * Assembly 此处 own motion-side CLI 教学：按 enum switch 1 primary action per case
 * (DP「相关」derive / 反 phase 1476 anti-pattern #5「多 options」).
 *
 * State 接 via Runtime extraMeta wire (watchdog-log.ts writeClawCrashedInbox
 * extraFields → encodeInbox YAML → 收件方 extraMeta).
 *
 * 业主类型 CrashClass type-only import (peer L6↔L6 装配综合本职、不违 M#5).
 *
 * Sub-case 行为：
 *  - active_unexpected: 教 motion 重启 daemon (`chestnut claw <id> daemon`) + inspect (steps)
 *  - active_user_stopped: read-only inspect (status + steps)、不附 restart 暗示（保 design intent）
 *  - unknown: fallback inspect (steps)（phase 201 删 null 旁路、不静默吞）
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { clawCmd, CLAW_VERBS } from '../../../cli/utils/cli-commands.js';
import type { CrashClass } from '../../../watchdog/claw-failure-classes.js';


interface ClawCrashedState {
  crash_class: string;        // serialized CrashClass enum
  claw_id: string;
  clean_stop_marker?: string;  // 'true' | 'false'
  contract?: string;
  outbox_pending?: string;
}

function isCrashClass(s: string | undefined): s is CrashClass {
  return s === 'active_unexpected' || s === 'active_user_stopped';
}

export const composer: GuidanceComposer<ClawCrashedState> = (state): GuidanceEntry => {
  const cls = state.crash_class;
  const id = state.claw_id || '<claw-id>';
  // phase 201: 删 unknown / user_stopped null 旁路
  // - unknown → fallback inspect（与 Step A claw_inactivity 同型最小 hint）
  // - active_user_stopped → read-only inspect（保 design intent「不附 restart 暗示」、但出 status/steps 让 motion 可调研）
  if (!isCrashClass(cls)) {
    return {
      text: `To inspect: ${clawCmd(id, CLAW_VERBS.STEPS)}`,
    };
  }
  switch (cls) {
    case 'active_unexpected':
      // phase 4: 2-line guidance — primary action (restart) + optional diagnostic (steps)
      // 不冲突 phase 1476 anti-pattern #5: restart vs steps 是 orthogonal (action vs investigation)、不是「motion 在等价选项中选 1」
      return {
        text: `To restart: ${clawCmd(id, CLAW_VERBS.DAEMON)}\nTo inspect what the claw was doing before crash: ${clawCmd(id, CLAW_VERBS.STEPS)}`,
      };
    case 'active_user_stopped':
      // phase 201: design intent「不暗示 restart」保留 → read-only inspect only
      return {
        text: `To check current status: ${clawCmd(id, CLAW_VERBS.STATUS)}\nTo inspect what the claw was doing: ${clawCmd(id, CLAW_VERBS.STEPS)}`,
      };
    default: {
      const _exhaustive: never = cls;
      return _exhaustive;
    }
  }
};
