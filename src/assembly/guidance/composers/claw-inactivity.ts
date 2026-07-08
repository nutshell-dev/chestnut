/**
 * @module L6.Assembly.Guidance
 * phase 1482 γ3 → phase 201:
 *   - 删 unknown class null 旁路、unknown 走 fallback inspect (steps) + watch
 *   - 与 phase 188 unknown_status / phase 197 archive_pending_recovery 同治理路径：unknown 不静默
 *
 * 业主 (watchdog) own FailureClass enum + base body 字面。
 * Assembly 此处 own motion-side CLI 教学：按 enum switch 1 primary action per case
 * (DP「相关」derive / 反 phase 1476 anti-pattern #5 「多 options」).
 *
 * State 接 via Runtime extraMeta wire (watchdog-log.ts writeClawInactivityInbox
 * extraFields → encodeInbox YAML → 收件方 extraMeta).
 *
 * 业主类型 FailureClass type-only import (peer L6↔L6 装配综合本职、不违 M#5).
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { clawCmd, CLAW_VERBS } from '../../../cli/utils/cli-commands.js';
import type { FailureClass } from '../../../watchdog/claw-failure-classes.js';


interface ClawInactivityState {
  failure_class: string;       // serialized FailureClass enum
  claw_id: string;
  inactive_ms?: string;
  status?: string;
  contract?: string;
  notify_count?: string;
  last_error?: string;
}

function isFailureClass(s: string | undefined): s is FailureClass {
  return s === 'daemon_silent' || s === 'daemon_errored';
}

// phase 2 γ4: daemon_stopped case 移除（归 claw_crashed composer 覆盖、两 type 互斥状态 0 dedup 重叠）
// phase 4: guidance 字面统一英文 / 简化 = 单 CLI line (diagnostic only, 无 restart — daemon 还活着不该 restart)
// phase 5: 加 watch subscription CLI 教学 (motion 干预后若仍 stuck 主动订阅再提醒 / DP 系统为智能体服务)
export const composer: GuidanceComposer<ClawInactivityState> = (state): GuidanceEntry => {
  const cls = state.failure_class;
  const id = state.claw_id || '<claw-id>';
  // phase 201: 删 unknown class null 旁路、改 fallback guidance（state.claw_id 仍可用）
  const inspect = isFailureClass(cls)
    ? renderKnownInspect(cls, id)
    : `To inspect: ${clawCmd(id, CLAW_VERBS.STEPS)}`;  // unknown fallback、与 daemon_errored 同型最小 hint
  const watch = `To be notified if it remains stuck after intervention: ${clawCmd(id, CLAW_VERBS.WATCH)} --inactive-after 5m`;
  return { text: `${inspect}\n${watch}` };
};

function renderKnownInspect(cls: FailureClass, id: string): string {
  switch (cls) {
    case 'daemon_silent':
      return `To inspect what the agent is stuck on: ${clawCmd(id, CLAW_VERBS.STEPS)}`;
    case 'daemon_errored':
      return `To inspect: ${clawCmd(id, CLAW_VERBS.STEPS)}`;
    default: {
      const _exhaustive: never = cls;
      return _exhaustive;
    }
  }
}
