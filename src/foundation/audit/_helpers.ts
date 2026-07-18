/**
 * Audit 模块内部 helper — TSV 字段转义 + 字段长度截断
 *
 * 转义优先级：\\ 先转（防后续替换产生的 \\ 被二次转义）→ \t / \n / \r / \0
 *
 * 应用范围：writer.ts AuditWriter.write
 *
 * Module-local（`_` 前缀、不 export from index.ts barrel、外部不可见）。
 * phase 41 Step B 抽出（auditlog-auditor §7.1 #2 follow-up）。
 * phase 213 Step A 增加 clip helper：audit field cap 归 audit 模块 own。
 */

import { AUDIT_PREVIEW_LEN, AUDIT_MESSAGE_MAX_CHARS, SUMMARY_MAX_CHARS } from './defaults.js';

export function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')   // \\ 先转（防后续替换产生的 \\ 被二次转义）
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0');
}

function clip(s: string, cap: number): string {
  const content = (s ?? '').trimStart();
  return content.length <= cap ? content : content.slice(0, cap) + '…';
}

export function clipPreview(s: string): string { return clip(s, AUDIT_PREVIEW_LEN); }
export function clipMessage(s: string): string { return clip(s, AUDIT_MESSAGE_MAX_CHARS); }
export function clipSummary(s: string): string { return clip(s, SUMMARY_MAX_CHARS); }
