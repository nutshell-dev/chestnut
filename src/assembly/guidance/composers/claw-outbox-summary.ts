/**
 * @module L6.Assembly.Guidance
 * phase 1476 γ2: motion guidance for `claw_outbox_summary` (γ2 首个 non-NO_GUIDANCE real composer).
 * phase 208: signature 收窄 GuidanceEntry | null → GuidanceEntry
 *   (body 本就单一 return { text }、无 null path、type 收窄 hygiene 对齐已收窄 5 composer)
 * phase 1259 Step B: composer 只经 ClawTopology owner codec（guidance-state.ts）取
 *   typed state — local wire interface / `Number()` + 静默 fallback 10 退役；
 *   NaN/0/inconsistent/malformed wire 由 decoder 抛 typed error（Runtime audit fallback）。
 *
 * 业主 (core/claw-topology/jobs/outbox-summary, phase 697) own facts (counts / total_claws / total_msgs / hash).
 * Assembly 此处 own motion-side CLI 教学：拼 `chestnut claw <claw-id> outbox --limit N`.
 *
 * 呈现策略（当前显式 decision，本 phase 不改）：`<claw-id>` placeholder + 总消息数
 * limit；motion LLM 按 body 中 counts breakdown 自家替换具体 id。per-claw 多命令
 * 呈现归后续 typed binding / CLIProtocol phase。
 */

import type { GuidanceComposer, GuidanceEntry } from '../types.js';
import { renderClawInvocation } from '../../../cli-protocol/index.js';
import { decodeOutboxSummaryGuidance } from '../../../core/claw-topology/jobs/outbox-summary/guidance-state.js';

export const composer: GuidanceComposer = (input): GuidanceEntry => {
  const state = decodeOutboxSummaryGuidance(input);
  const cmd = renderClawInvocation('<claw-id>', 'outbox');
  return {
    text: `查看具体内容： ${cmd} --limit ${state.totalMsgs}`,
  };
};
