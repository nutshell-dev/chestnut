/**
 * M07 inbox 文案：claw outbox 未读汇总（head/逐 claw 行/范围说明/历史重复提示/扫描失败警告）。
 * 触发/接收者：ClawTopology outbox-summary job → motion inbox（claw_outbox_summary，normal）。
 * 原 owner：core/claw-topology（排序、重复判断、失败集合仍归 owner）。
 * phase 1834：语义治理 —— 说明观察范围与读取消费副作用；不再从重复推断已读、
 * 不再附 outbox-skip 建议（CLI 读取命令字面与用途标签仍归 CLIProtocol，不入本目录）。
 */

export function outboxSummaryHead(totalClaws: number, totalMsgs: number): string {
  return `未读消息提醒：扫描发现 ${totalClaws} 个 claw 共 ${totalMsgs} 条未读消息。`;
}

/** 逐 claw 行：预览缺省显示 `(无预览)`。 */
export function outboxSummaryClawLine(clawId: string, count: number, preview: string | undefined): string {
  return `- ${clawId}：${count} 条；最后一条预览：「${preview ?? '(无预览)'}」`;
}

/**
 * phase 1834：预览范围与读取消费副作用说明（两条事实陈述，不绑定扫描时集合、
 * 不冒称当前瞬间完整状态）。
 */
export function outboxSummaryScopeHint(): string {
  return [
    '预览仅展示各 claw 最后一条消息的首行片段，不代表全部未读内容。',
    '需要了解消息内容时，可使用下方读取命令。命令会读取并消费消息，消费后归档；--limit 是最多读取条数，不绑定本次扫描的消息集合。消息可能已被消费或有新消息到达，以实际读取结果为准。',
  ].join('\n');
}

/**
 * phase 1834：历史重复提示块（前导空行）。只陈述「曾出现在历史提醒中」这一事实；
 * 不推断已读、不写「与上一条完全相同」、不附 skip 建议。
 */
export function outboxSummaryRepeatHint(): string[] {
  return [
    '',
    '这些消息曾出现在历史未读提醒中；重复提醒不表示你已读取过消息正文。',
  ];
}

export function outboxSummaryIncompleteWarning(failedClaws: readonly string[]): string {
  return `警告：以下 claw 扫描失败，计数可能不完整 — ${failedClaws.join(', ')}`;
}

export function outboxSummaryBody(parts: readonly string[]): string {
  return parts.join('\n');
}
