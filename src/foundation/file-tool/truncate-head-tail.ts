/**
 * @module L2c.FileTool
 *
 * Head + tail 截断保留、用于 file-tool/read 与 command-tool/exec 共享。
 * Derivation: HEAD 600 + TAIL 1400 = 2000B = EXEC_MAX_OUTPUT、head:tail = 3:7
 * 给 tail 更多空间因 error trace 偏 tail。两 caller 业务 truncation 协议一致。
 * phase 524: 抽 file-tool/read.ts 和 command-tool/exec.ts 两 私有 truncateHeadTail 实现。
 * phase 712: 从 utils/ 迁入 file-tool/。
 */
export const TRUNCATE_HEAD_LIMIT = 600;
export const TRUNCATE_TAIL_LIMIT = 1400;
export const TRUNCATE_TOTAL_LIMIT = TRUNCATE_HEAD_LIMIT + TRUNCATE_TAIL_LIMIT;

/**
 * 截断 content head+tail、中间替「[...truncated N bytes...]」+ 「Full output 提示」。
 * 不做阈值判 — caller 自己决定何时调。
 */
export function truncateHeadTail(content: string, relPath: string): string {
  const head = content.slice(0, TRUNCATE_HEAD_LIMIT);
  const tail = content.slice(-TRUNCATE_TAIL_LIMIT);
  const truncatedBytes = content.length - TRUNCATE_HEAD_LIMIT - TRUNCATE_TAIL_LIMIT;
  return `${head}\n[...truncated ${truncatedBytes} bytes...]\n${tail}\nFull output (${content.length} bytes) saved. Use \`read\` with offset/limit to view ranges (read is capped per call, paginate by offset):\n  read: { "path": "${relPath}", "offset": 1, "limit": 200 }`;
}
