/**
 * @module L6.Assembly.Guidance
 * phase 1482 γ3: motion guidance for `claw_inactivity` real composer
 * (phase 1469 17 NO_GUIDANCE → 1st real, mirror phase 1476 claw_outbox_summary).
 *
 * 业主 (watchdog) own FailureClass enum + base body 字面。
 * Assembly 此处 own motion-side CLI 教学：按 enum switch 1 primary action per case
 * (DP「相关」derive / 反 phase 1476 anti-pattern #5 「多 options」).
 *
 * State 接 via Runtime extraMeta wire (watchdog-log.ts writeClawInactivityInbox
 * extraFields → encodeInbox YAML → 收件方 extraMeta).
 *
 * 业主类型 FailureClass type-only import (peer L6↔L6 装配综合本职、不违 ML#5).
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { clawCmd, CLAW_VERBS } from '../../../cli/commands/registry.js';
import type { FailureClass } from '../../../watchdog/watchdog-utils.js';

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
  return s === 'daemon_stopped' || s === 'daemon_silent' || s === 'daemon_errored';
}

export const composer: GuidanceComposer<ClawInactivityState> = (state): GuidanceEntry | null => {
  const cls = state.failure_class;
  if (!isFailureClass(cls)) return null;  // unknown class → null (Runtime fallback graceful)
  const id = state.claw_id || '<claw-id>';
  switch (cls) {
    case 'daemon_stopped':
      return { text: `重启 daemon： ${clawCmd(id, CLAW_VERBS.DAEMON)}` };
    case 'daemon_silent':
      return { text: `查看最近 steps 找 stuck 点： ${clawCmd(id, CLAW_VERBS.STEPS)}` };
    case 'daemon_errored':
      return { text: `查看最近 steps 含 error context（lastError 在 body 内）： ${clawCmd(id, CLAW_VERBS.STEPS)}` };
  }
};
