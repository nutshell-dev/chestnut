/**
 * @module L6.Assembly.Guidance
 * phase 1476 γ2: motion guidance for `claw_outbox_summary` (γ2 首个 non-NO_GUIDANCE real composer).
 * phase 208: signature 收窄 GuidanceEntry | null → GuidanceEntry
 *   (body 本就单一 return { text }、无 null path、type 收窄 hygiene 对齐已收窄 5 composer)
 *
 * 业主 (core/claw-topology/jobs/outbox-summary, phase 697) own facts (counts / total_claws / total_msgs / hash).
 * Assembly 此处 own motion-side CLI 教学：拼 `chestnut claw <claw-id> outbox --limit N`.
 *
 * State 接 via Runtime extraMeta wire (toExtraMeta serializes fields to Record<string,string>).
 * - state.total_msgs: total unread count, used for --limit hint
 * - state.total_claws: total claw count with unread
 * - state.counts: JSON {clawId: n} — composer 不解构（motion LLM 自家读 body 即可）
 * - state.hash: dedup key (composer 不消费、纯 sender-side concern)
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { clawCmd, CLAW_VERBS } from '../../../cli/utils/cli-commands.js';

interface ClawOutboxSummaryState {
  hash: string;
  total_claws: string;
  total_msgs: string;
  counts: string;       // JSON stringified
}

export const composer: GuidanceComposer<ClawOutboxSummaryState> = (state): GuidanceEntry => {
  const limit = Number(state.total_msgs);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 10;
  // motion LLM 拿 <claw-id> 占位、按 body 中 counts breakdown 自家替换具体 id
  const cmd = clawCmd('<claw-id>', CLAW_VERBS.OUTBOX);
  return {
    text: `查看具体内容： ${cmd} --limit ${safeLimit}`,
  };
};
