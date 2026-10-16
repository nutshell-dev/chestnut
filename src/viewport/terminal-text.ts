/**
 * @module L6.CLIProtocol.TerminalText
 * phase 1874 Step B（cli-viewport-module-boundary）：viewport 模块提取时，CLI 与 viewport
 * 共用的终端文本呈现原语（视觉宽度截取/单行适配/折行/多行加前缀）集中于 CLI 呈现层 owner。
 * 原址：cli/utils/string.ts + cli/utils/constants.ts（CLIProcess 内部；viewport 独立后不可深引）。
 */

import stringWidth from 'string-width';

/**
 * Fallback terminal width (columns) when `process.stdout.columns` is unavailable.
 * 80 = classic POSIX default (predates wide terminals).
 */
export const DEFAULT_TERMINAL_WIDTH = 80;

/**
 * 按视觉列宽从头截取字符串（正确处理 emoji / CJK 等宽字符）
 */
export function sliceFromStart(s: string, maxCols: number): string {
  let w = 0;
  let i = 0;
  while (i < s.length) {
    // 跳过 ANSI CSI 序列：\x1b[ ... m（零可见宽度）
    if (s[i] === '\x1b' && s[i + 1] === '[') {
      const end = s.indexOf('m', i + 2);
      if (end !== -1) { i = end + 1; continue; }
    }
    const cp = s.codePointAt(i) ?? 0;
    const charLen = cp > 0xFFFF ? 2 : 1;
    const cw = stringWidth(s.slice(i, i + charLen));
    if (w + cw > maxCols) break;
    w += cw;
    i += charLen;
  }
  return s.slice(0, i);
}

/**
 * 将字符串适配为单行显示：
 * - \r / \n 替换为空格（保留所有内容，只消除换行/回车）
 * - 按终端宽度截断，超出追加 '…'
 * - 预留 1 列给 '…'，避免 off-by-one 溢出
 */
export function fitLine(s: string, cols?: number): string {
  const width = cols ?? (process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH);
  const flat = s.replace(/\r\n?|\n/g, ' ');
  if (stringWidth(flat) <= width) return flat;
  return sliceFromStart(flat, width - 1) + '…';
}

/**
 * 将单行字符串按终端宽度折行，返回多行数组。
 * 正确处理 emoji / CJK 等宽字符。不截断内容。
 * @param hangIndent - 续行缩进前缀（默认空字符串），用于视觉上区分首行和续行
 */
/**
 * 将多行文本的每行加上前缀和续行缩进：首行加 prefix，续行加 indent。
 * 用于 viewport 中 LLM 输出 / 用户回复的多行文本统一显示格式。
 */
export function prefixLines(text: string, prefix: string, indent: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? prefix : indent) + line)
    .join('\n');
}

export function wrapLine(s: string, cols?: number, hangIndent = ''): string[] {
  const width = cols ?? (process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH);
  if (stringWidth(s) <= width) return [s];
  const indentW = stringWidth(hangIndent);
  const lines: string[] = [];
  let remaining = s;
  let first = true;
  while (remaining && stringWidth(remaining) > (first ? width : width - indentW)) {
    const avail = Math.max(1, first ? width : width - indentW);
    const chunk = sliceFromStart(remaining, avail);
    lines.push(first ? chunk : hangIndent + chunk);
    remaining = remaining.slice(chunk.length);
    first = false;
  }
  if (remaining) lines.push(first ? remaining : hangIndent + remaining);
  return lines;
}
