/**
 * @module L4.ClawTopology.OutboxSummary
 * phase 42: write new summary 走 Messaging.InboxWriter（消 MLP-3 直访）。
 *
 * hash 放 InboxMessage.extraMeta（经 InboxWriter.write extraFields 落 frontmatter）、
 * dedup 查询不再依赖文件名 schema。
 * phase 1259 Step A: extra 只经 owner codec（guidance-state.ts）产出 v1 最小
 * metadata — 手工平铺 serializer + hash 双源退役（M#7/M#8）。
 * phase 1754 Step B: 重复推送的逐 claw outbox-skip 命令行不再由本文件拼接裸
 * `chestnut` 字面（M#5）— 只交付 typed affordance（claw.outbox-skip action），
 * 最终 invocation 文本唯一归 CLIProtocol 渲染（renderCliGuidanceAction）。
 */

import type { AuditLog } from '../../../../foundation/audit/index.js';
import type { InboxWriter } from '../../../../foundation/messaging/index.js';
import type { InboxMessage } from '../../../../foundation/messaging/index.js';
import { renderCliGuidanceAction } from '../../../../cli-protocol/index.js';
import { OUTBOX_SUMMARY_AUDIT_EVENTS } from './audit-events.js';
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
  const head = `[system] outbox 未读：共 ${state.total_claws} 个 claw ${state.total_msgs} 条消息`;
  const lines = Object.entries(state.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, n]) => `- ${id} (${n}): 「${state.previews[id] ?? '(无预览)'}」`);
  const parts = [head, ...lines];
  if (isRepeat) {
    // phase 1749: 重复推送（同 hash 曾在 24h 窗外推送过）→ motion 已看过、
    // 未处理/不需要处理，追加逐 claw 的 outbox-skip 使用指引（事件驱动教学、零预灌）。
    parts.push(
      '',
      '〔提示〕以上未读消息与此前推送完全重复。若你已确认这些消息无需处理，可执行以下命令跳过对应 claw 的未读消息（归档到 done/、不再提醒）：',
      ...Object.keys(state.counts)
        .sort((a, b) => a.localeCompare(b))
        .map((id) => `  ${renderCliGuidanceAction({ kind: 'claw.outbox-skip', target: { kind: 'claw', id } })}`),
    );
  }
  if (state.incomplete) {
    parts.push(`警告：以下 claw 扫描失败，计数可能不完整 — ${state.failed_claws.join(', ')}`);
  }
  return parts.join('\n');
}
