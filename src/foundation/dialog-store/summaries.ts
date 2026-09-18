/**
 * @module L2b.DialogStore.ContextTrimSummary
 * phase 1861 (CM-D5)：context trim 汇总消息构造——消息形状归 owner（DialogStore）。
 *
 * ContextManager 只产统计（subtypeStat/toolStat/processedCount，裁剪知识留 CM），
 * 消息字面（role/origin/systemSubtype='context_trim_summary'）仅在此处定义。
 * 迁移自 src/core/context_manager/trim-v2.ts buildSummaryMessage（1:1、文本格式不变）。
 */

import type { Message } from './canonical-message.js';

/** CM 侧采集的裁剪统计（结构归 owner，CM import 消费）。 */
export interface ContextTrimSummaryStats {
  /** 已处理（参与压缩）的消息条数。 */
  processedCount: number;
  /** 系统通知子类型保留计数。 */
  subtypeStat: { preserved: Record<string, number> };
  /** 工具调用计数。 */
  toolStat: { total: number; byTool: Record<string, number> };
  /** 裁剪时刻 (ms epoch)。 */
  nowMs: number;
}

/** 构造 context trim 汇总消息（systemSubtype='context_trim_summary'）。 */
export function buildContextTrimSummaryMessage(stats: ContextTrimSummaryStats): Message {
  const { processedCount, subtypeStat, toolStat, nowMs } = stats;
  const nowIso = new Date(nowMs).toISOString();
  const preservedStr = Object.entries(subtypeStat.preserved)
    .map(([k, v]) => `${k} × ${v}`)
    .join('、') || '无';
  const toolStr = Object.entries(toolStat.byTool)
    .map(([k, v]) => `${k} ${v}`)
    .join('、') || '无';
  const content = `[context-trim summary] 以下为裁剪边界（裁剪时间：${nowIso}）。前 ${processedCount} 条消息已处理：系统通知（保留预览）：${preservedStr}；工具调用：${toolStat.total} 次（${toolStr}）。查回原文：dialog 归档 archive/<ts>_<uuid>.json`;
  return {
    role: 'user',
    content,
    origin: 'system',
    systemSubtype: 'context_trim_summary',
    addedAt: nowIso,
  };
}
