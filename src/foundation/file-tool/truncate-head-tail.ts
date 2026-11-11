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
  const readHint = relPath
    ? `\nFull output (${totalBytes} bytes) saved. Use \`read\` with offset/limit to view ranges (read is capped per call, paginate by offset):\n  read: { "path": ${JSON.stringify(relPath)}, "offset": 1, "limit": 200 }`
    : '';
  return truncatedBytes === 0
    ? content + readHint
    : `${head}\n[...truncated ${truncatedBytes} bytes...]\n${tail}${readHint}`;
}
