/**
 * @module L4.ClawTopology.OutboxSummary
 * phase 42: write new summary 走 Messaging.InboxWriter（消 MLP-3 直访）。
 *
 * hash 放 InboxMessage.extraMeta（经 InboxWriter.write extraFields 落 frontmatter）、
 * dedup 查询不再依赖文件名 schema。
 */

import type { AuditLog } from '../../../../foundation/audit/index.js';
import type { InboxWriter } from '../../../../foundation/messaging/index.js';
import type { InboxMessage } from '../../../../foundation/messaging/index.js';
import { OUTBOX_SUMMARY_AUDIT_EVENTS } from './audit-events.js';
import { MOTION_CLAW_ID } from '../../index.js';
import { SUMMARY_HASH_META_KEY } from './dedup.js';
import { toExtraMeta } from './types.js';
import type { OutboxSummaryState } from './types.js';

export const SUMMARY_INBOX_TYPE = 'claw_outbox_summary';

export interface WriteDeps {
  inboxWriter: InboxWriter;
  audit: AuditLog;
  now?: () => number;
}

export async function writeNewSummary(
  deps: WriteDeps,
  state: OutboxSummaryState,
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const body = formatBody(state);
  const extra = { ...toExtraMeta(state), [SUMMARY_HASH_META_KEY]: state.hash };
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
  );
}

function formatBody(state: OutboxSummaryState): string {
  const head = `[system] outbox 未读：共 ${state.total_claws} 个 claw ${state.total_msgs} 条消息`;
  const lines = Object.entries(state.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, n]) => `- ${id} (${n}): 「${state.previews[id] ?? '(无预览)'}」`);
  return [head, ...lines].join('\n');
}
