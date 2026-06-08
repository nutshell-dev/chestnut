/**
 * @module L6.Assembly.Guidance
 * phase 2 γ4: motion guidance for `crash_notification` real composer
 * (phase 1469 16 NO_GUIDANCE → 15 / 第 3 个 real composer 继 phase 1476 + 1482).
 *
 * 业主 (watchdog) own CrashClass enum + base body 字面 + clean-stop marker 探测。
 * Assembly 此处 own motion-side CLI 教学：按 enum switch 1 primary action per case
 * (DP「相关」derive / 反 phase 1476 anti-pattern #5「多 options」).
 *
 * State 接 via Runtime extraMeta wire (watchdog-log.ts writeCrashNotificationInbox
 * extraFields → encodeInbox YAML → 收件方 extraMeta).
 *
 * 业主类型 CrashClass type-only import (peer L6↔L6 装配综合本职、不违 ML#5).
 *
 * Sub-case 行为：
 *  - active_unexpected: 教 motion 重启 daemon (`chestnut claw <id> daemon`)
 *  - active_user_stopped: null FYI (motion 知情即可、不教 action)
 *  - unknown: null fallback (Runtime audit emit `guidance_composer_failed` 兜底)
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { clawCmd, CLAW_VERBS } from '../../../cli/commands/registry.js';
import type { CrashClass } from '../../../watchdog/watchdog-utils.js';
import { assertNever } from '../../../foundation/utils/index.js';

interface CrashNotificationState {
  crash_class: string;        // serialized CrashClass enum
  claw_id: string;
  clean_stop_marker?: string;  // 'true' | 'false'
  contract?: string;
  outbox_pending?: string;
}

function isCrashClass(s: string | undefined): s is CrashClass {
  return s === 'active_unexpected' || s === 'active_user_stopped';
}

export const composer: GuidanceComposer<CrashNotificationState> = (state): GuidanceEntry | null => {
  const cls = state.crash_class;
  if (!isCrashClass(cls)) return null;
  const id = state.claw_id || '<claw-id>';
  switch (cls) {
    case 'active_unexpected':
      // phase 4: 2-line guidance — primary action (restart) + optional diagnostic (steps)
      // 不冲突 phase 1476 anti-pattern #5: restart vs steps 是 orthogonal (action vs investigation)、不是「motion 在等价选项中选 1」
      return {
        text: `To restart: ${clawCmd(id, CLAW_VERBS.DAEMON)}\nTo inspect what the claw was doing before crash: ${clawCmd(id, CLAW_VERBS.STEPS)}`,
      };
    case 'active_user_stopped':
      return null;  // FYI — motion 知情即可（用户主动 stop 通常 motion 已知 / 不附 restart 暗示）
    default:
      return assertNever(cls);
  }
};
