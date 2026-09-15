/**
 * @module L4.ClawTopology.OutboxSummary
 * phase 42: write new summary 走 Messaging.InboxWriter（消 MLP-3 直访）。
 *
 * hash 放 InboxMessage.extraMeta（经 InboxWriter.write extraFields 落 frontmatter）、
 * dedup 查询不再依赖文件名 schema。
 * phase 1259 Step A: extra 只经 owner codec（guidance-state.ts）产出 v1 最小
 * metadata — 手工平铺 serializer + hash 双源退役（M#7/M#8）。
 * phase 1834: 退役重复推送 skip 指引渲染 port 注入链 —— 重复提醒不再自动附
 * outbox-skip 建议、不再从重复推断 motion 已读；范围/消费说明与历史重复
 * 提示改由 templates 静态文案承载（M07 语义治理）。
 */

import type { AuditLog } from '../../../../foundation/audit/index.js';
import type { InboxWriter } from '../../../../foundation/messaging/index.js';
import type { InboxMessage } from '../../../../foundation/messaging/index.js';
import { OUTBOX_SUMMARY_AUDIT_EVENTS } from './audit-events.js';
import {
  outboxSummaryBody,
  outboxSummaryClawLine,
  outboxSummaryHead,
  outboxSummaryIncompleteWarning,
  outboxSummaryRepeatHint,
  outboxSummaryScopeHint,
} from '../../../../templates/messages/index.js';
import { MOTION_CLAW_ID } from '../../motion-claw-id.js';
import { encodeOutboxSummaryGuidance } from './guidance-state.js';
import type { OutboxSummaryState } from './types.js';

export const SUMMARY_INBOX_TYPE = 'claw_outbox_summary';

interface WriteDeps {
  inboxWriter: InboxWriter;
  audit: AuditLog;
  now?: () => number;
}

export async function writeNewSummary(
  deps: WriteDeps,
  state: OutboxSummaryState,
  opts: { isRepeat?: boolean } = {},
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const body = formatBody(state, opts.isRepeat === true);
  const extra = encodeOutboxSummaryGuidance(state);
  const msg: InboxMessage = {
    id: `claw-outbox-summary-${state.hash}-${now}`,
    type: SUMMARY_INBOX_TYPE,
    from: 'system',
    to: MOTION_CLAW_ID,
    content: body,
    priority: 'normal',
    timestamp: new Date(now).toISOString(),
    extraMeta: extra,
  };

  await deps.inboxWriter.write(msg, extra);

  deps.audit.write(
    OUTBOX_SUMMARY_AUDIT_EVENTS.OUTBOX_SUMMARY_WRITTEN,
    `hash=${state.hash}`,
    `total_claws=${state.total_claws}`,
    `total_msgs=${state.total_msgs}`,
    `incomplete=${state.incomplete}`,
  );
}

function formatBody(state: OutboxSummaryState, isRepeat: boolean): string {
  const head = outboxSummaryHead(state.total_claws, state.total_msgs);
  const lines = Object.entries(state.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, n]) => outboxSummaryClawLine(id, n, state.previews[id]));
  const parts = [head, ...lines, outboxSummaryScopeHint()];
  if (isRepeat) {
    // phase 1834: 历史重复（同 hash 曾在 24h 窗外推送过）只追加「曾出现」事实陈述，
    // 不推断 motion 已读、不附 skip 建议；历史重复不保证与上一条提醒相同。
    parts.push(...outboxSummaryRepeatHint());
  }
  if (state.incomplete) {
    parts.push(outboxSummaryIncompleteWarning(state.failed_claws));
  }
  return outboxSummaryBody(parts);
}
