import type { FileSystem } from '../fs/types.js';

const TURN_START_SCAN_BYTES_DEFAULT = 64 * 1024;   // 64KB

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
  const fileOffset = readStart + lineStartInBuf;
  if (readStart > 0 && lineStartInBuf === 0) {
    const nextNl = text.indexOf('\n');
    if (nextNl === -1) return size;
    return readStart + nextNl + 1;
  }
  return fileOffset;
}
