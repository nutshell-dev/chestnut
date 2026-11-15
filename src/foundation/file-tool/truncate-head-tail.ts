/**
 * @module L2c.FileTool
 *
 * Head + tail 截断保留、用于 file-tool/read 与 command-tool/exec 共享。
 * Derivation: HEAD 600 + TAIL 1400 = 2000B = EXEC_MAX_OUTPUT、head:tail = 3:7
 * 给 tail 更多空间因 error trace 偏 tail。两 caller 业务 truncation 协议一致。
 * phase 524: 抽 file-tool/read.ts 和 command-tool/exec.ts 两 私有 truncateHeadTail 实现。
 * phase 712: 从 utils/ 迁入 file-tool/。
 */
import { truncateUtf8Prefix } from '../node-utils/index.js';

const TRUNCATE_HEAD_LIMIT = 600;
const TRUNCATE_TAIL_LIMIT = 1400;

/** Keep the legacy footer format shared by the old and explicitly bounded entry points. */
export function formatHeadTailReadHint(totalBytes: number, relPath: string): string {
  return `\nFull output (${totalBytes} bytes) saved. Use \`read\` with offset/limit to view ranges (read is capped per call, paginate by offset):\n  read: { "path": ${JSON.stringify(relPath)}, "offset": 1, "limit": 200 }`;
}

/**
 * 截断 content head+tail、中间替「[...truncated N bytes...]」+ 「Full output 提示」。
 * 不做阈值判 — caller 自己决定何时调。
 * relPath 可选：不提供时不附加 read 提示（用于无文件路径的场景，如 async exec partial output）。
 */
export function truncateHeadTail(content: string, relPath?: string): string {
  const head = truncateUtf8Prefix(content, TRUNCATE_HEAD_LIMIT);
  const bytes = Buffer.from(content, 'utf8');
  const totalBytes = bytes.length;
  const headBytes = Buffer.byteLength(head, 'utf8');
  let tailStart = Math.max(headBytes, totalBytes - TRUNCATE_TAIL_LIMIT);
  while (tailStart < totalBytes && (bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
  const tail = bytes.subarray(tailStart).toString('utf8');
  const truncatedBytes = totalBytes - headBytes - Buffer.byteLength(tail, 'utf8');
  const readHint = relPath ? formatHeadTailReadHint(totalBytes, relPath) : '';
  return truncatedBytes === 0
    ? content + readHint
    : `${head}\n[...truncated ${truncatedBytes} bytes...]\n${tail}${readHint}`;
}


/**
 * Explicit total-response budget entry point. `footer` is kept verbatim and is
 * included in `maxBytes`; the head/tail body receives only the remaining bytes.
 * Returns null when even a truncation marker and the complete footer cannot fit.
 * The legacy `truncateHeadTail` signature and its fixed 600/1400 budgets are unchanged.
 */
export function truncateHeadTailWithinBudget(
  content: string,
  maxBytes: number,
  footer = '',
): string | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  const footerBytes = Buffer.byteLength(footer, 'utf8');
  const bodyBudget = maxBytes - footerBytes;
  const bytes = Buffer.from(content, 'utf8');
  const totalBytes = bytes.length;
  // Reserving the marker with the original byte count is conservative: the
  // actual omitted count has no more digits, so the final marker cannot grow.
  const markerReserve = Buffer.byteLength(`\n[...truncated ${totalBytes} bytes...]\n`, 'utf8');
  if (bodyBudget < markerReserve) return null;

  const previewBytes = bodyBudget - markerReserve;
  const headBudget = Math.min(TRUNCATE_HEAD_LIMIT, Math.floor(previewBytes * 0.3));
  const tailBudget = Math.min(TRUNCATE_TAIL_LIMIT, previewBytes - headBudget);
  const head = truncateUtf8Prefix(content, headBudget);
  const headBytes = Buffer.byteLength(head, 'utf8');

  let tailStart = Math.max(headBytes, totalBytes - tailBudget);
  while (tailStart < totalBytes && (bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
  const tail = bytes.subarray(tailStart).toString('utf8');
  const truncatedBytes = totalBytes - headBytes - Buffer.byteLength(tail, 'utf8');
  const body = truncatedBytes === 0
    ? content
    : `${head}\n[...truncated ${truncatedBytes} bytes...]\n${tail}`;
  const result = body + footer;

  // Defend the total-response contract even for non-overflow direct callers.
  return Buffer.byteLength(result, 'utf8') <= maxBytes ? result : null;
}
