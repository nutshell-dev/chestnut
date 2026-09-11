/**
 * M07 inbox 文案：claw outbox 未读汇总（head/逐 claw 行/重复提示/扫描失败警告）。
 * 触发/接收者：ClawTopology outbox-summary job → motion inbox（claw_outbox_summary，normal）。
 * 原 owner：core/claw-topology（排序、重复判断、失败集合、skip 指引渲染仍归 owner）。
 */

export function outboxSummaryHead(totalClaws: number, totalMsgs: number): string {
  return `[system] outbox 未读：共 ${totalClaws} 个 claw ${totalMsgs} 条消息`;
}

/** 逐 claw 行：预览缺省显示 `(无预览)`。 */
export function outboxSummaryClawLine(clawId: string, count: number, preview: string | undefined): string {
  return `- ${clawId} (${count}): 「${preview ?? '(无预览)'}」`;
}

/** 重复推送提示块（含已渲染命令行的两空格缩进）。 */
export function outboxSummaryRepeatHint(skipHintLines: readonly string[]): string[] {
  return [
    '',
    '〔提示〕以上未读消息与此前推送完全重复。若你已确认这些消息无需处理，可执行以下命令跳过对应 claw 的未读消息（归档到 done/、不再提醒）：',
    ...skipHintLines.map((line) => `  ${line}`),
  ];
}

export function outboxSummaryIncompleteWarning(failedClaws: readonly string[]): string {
  return `警告：以下 claw 扫描失败，计数可能不完整 — ${failedClaws.join(', ')}`;
}

export function outboxSummaryBody(parts: readonly string[]): string {
  return parts.join('\n');
}
