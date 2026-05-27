import stringWidth from 'string-width';

export { oneLine } from '../../foundation/utils/format.js';

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
 * - \n 替换为空格（保留所有内容，只消除换行）
 * - 按终端宽度截断，超出追加 '…'
 * - 预留 1 列给 '…'，避免 off-by-one 溢出
 */
export function fitLine(s: string, cols?: number): string {
  const width = cols ?? (process.stdout.columns ?? 80);
  const flat = s.replace(/\n/g, ' ');
  if (stringWidth(flat) <= width) return flat;
  return sliceFromStart(flat, width - 1) + '…';
}

/**
 * 将单行字符串按终端宽度折行，返回多行数组。
 * 正确处理 emoji / CJK 等宽字符。不截断内容。
 * @param hangIndent - 续行缩进前缀（默认空字符串），用于视觉上区分首行和续行
 */
export function wrapLine(s: string, cols?: number, hangIndent = ''): string[] {
  const width = cols ?? (process.stdout.columns ?? 80);
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
