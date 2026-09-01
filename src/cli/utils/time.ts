/**
 * @module L6.CLI.Utils.Time
 * Phase 1268 Step D: viewport 故障/调度行的时间格式集中 helper。
 * HH:MM:SS（本地时区）；测试注入固定 Date 断言结构，不依赖运行机 locale 字符串。
 */

function formatClockTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mi}:${ss}`;
}

/** ISO 时间串 → `HH:MM:SS`；不可解析返回原串（容错，不静默丢信息）。 */
export function formatIsoClock(iso: unknown): string {
  if (typeof iso !== 'string') return String(iso);
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return formatClockTime(new Date(ms));
}
