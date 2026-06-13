import type { FileSystem } from '../fs/types.js';

/**
 * Default scan window 字节数 - turn-start 位置 backward 搜寻预算.
 * Derivation: 64 * 1024 = 64KB ≈ 30K 中文字 / 覆盖最近 1-2 个 turn 的 stream content /
 * 配 TEXT_BUFFER_CAP (64KB) 同值因 scan 窗口与 in-mem buffer 对齐 /
 * 防巨型 turn (mass tool output) 时 scan OOM.
 */
const TURN_START_SCAN_BYTES_DEFAULT = 64 * 1024;

/**
 * 启动期 backward scan stream.jsonl 找最近 turn_start byte offset。
 *
 * chat-viewport spinner bug fix（phase 522）首发 / phase 558 §B.6 推 foundation/stream/ 共用 /
 * gateway streamReader 同型 fix 复用 / 防客户端重连 broadcast 空。
 *
 * @param fs - FileSystem
 * @param streamPath - stream.jsonl 路径（fs baseDir 相对）
 * @param scanBytes - 反向 scan 字节数 / default 64KB
 * @returns 最近 turn_start line 起点 byte offset / 没找到返 file size（fallback to tail）
 */
export function findRecentTurnStartOffset(
  fs: FileSystem,
  streamPath: string,
  scanBytes = TURN_START_SCAN_BYTES_DEFAULT,
): number {
  if (!fs.existsSync(streamPath)) return 0;
  const size = fs.statSync(streamPath).size;
  if (size === 0) return 0;
  const readStart = Math.max(0, size - scanBytes);
  const buf = fs.readBytesSync(streamPath, readStart, size);
  const text = buf.toString('utf-8');
  const marker = '"type":"turn_start"';
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return size;
  const lineStartInBuf = text.lastIndexOf('\n', idx) + 1;
  // phase 324 H9: lineStartInBuf 是 JS UTF-16 code-unit index；readStart 是文件
  // 字节偏移。直接相加在含非 ASCII（CJK）时偏 → StreamReader resume off codepoint
  // → parse_fail loop escalate corrupt detection。改用 Buffer.byteLength 把
  // 前缀字符串重编码为 utf-8 字节数，再加 readStart。
  const lineStartByteOffsetInBuf = Buffer.byteLength(text.slice(0, lineStartInBuf), 'utf-8');
  const fileOffset = readStart + lineStartByteOffsetInBuf;
  if (readStart > 0 && lineStartInBuf === 0) {
    const nextNl = text.indexOf('\n');
    if (nextNl === -1) return size;
    // 同上：nextNl + 1 也是 UTF-16 index，需 byteLength。
    const nextNlByteOffsetInBuf = Buffer.byteLength(text.slice(0, nextNl + 1), 'utf-8');
    return readStart + nextNlByteOffsetInBuf;
  }
  return fileOffset;
}
