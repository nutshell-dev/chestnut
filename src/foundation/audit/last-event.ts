/**
 * @module L2a.AuditLog.LastEvent
 *
 * phase 1873 Step K（daemon-last-exit-bypasses-audit-owner）：audit 尾部事件的
 * 稳定读取 query——tsv 物理格式（行/列/`seq=N` col 兼容/tail 字节读）收口在
 * owner 内；caller 得 typed 事实，不直读文件、不解析格式、不硬编码业务事件。
 *
 * 读取语义分层显式（不折静默）：
 * - `none`：文件不存在 / 空 / 尾部无可解析行（调用方按「无退出记录」处理）；
 * - `io_error`：非 ENOENT 读取失败——原样携带，由 caller 决定留证（不冒充 none）。
 */
import { isFileNotFound, type FileSystem } from '../fs/index.js';

/**
 * audit.tsv 尾部读字节数（用于 readBytesSync(start, end) tail read）.
 * Derivation: 4096 = 4KB ≈ Linux 默认 page size / ≈ 30-50 audit rows
 * 给最后一次进程退出语义重构提供足够 context（最近事件 + 退出 trigger）.
 * 4KB 是 fs read 的物理操作单元 / smaller 浪费 syscall / larger 浪费 memory.
 */
const TAIL_BYTES = 4096;

export interface AuditEventRecord {
  ts: string;
  type: string;
  cols: string[];
}

export type LastAuditEventResult =
  | { kind: 'found'; event: AuditEventRecord }
  | { kind: 'none' }
  | { kind: 'io_error'; error: unknown };

/**
 * 读取 audit.tsv 的最后一行非空记录（owner 内部完成 tail 读与解析）。
 */
export function readLastAuditEvent(fs: FileSystem, auditPath: string): LastAuditEventResult {
  let lines: string[];
  try {
    if (!fs.existsSync(auditPath)) return { kind: 'none' };
    const stat = fs.statSync(auditPath);
    if (stat.size === 0) return { kind: 'none' };

    if (stat.size <= TAIL_BYTES) {
      lines = fs.readSync(auditPath).split('\n').filter(Boolean);
    } else {
      const offset = stat.size - TAIL_BYTES;
      const buf = fs.readBytesSync(auditPath, offset, stat.size);
      const chunk = buf.toString('utf-8');
      // 切掉首段不完整行（offset 落在某行中间的可能）
      const newlineIdx = chunk.indexOf('\n');
      const safeChunk = newlineIdx >= 0 ? chunk.slice(newlineIdx + 1) : chunk;
      lines = safeChunk.split('\n').filter(Boolean);
      // 极端情况：单行长度 > TAIL_BYTES，safeChunk 拿不到完整行，回退全读
      if (lines.length === 0) {
        lines = fs.readSync(auditPath).split('\n').filter(Boolean);
      }
    }
  } catch (err) {
    // silent: 读取错误经 io_error typed 结果原样交付 caller（不在本层 audit/throw）
    if (isFileNotFound(err)) return { kind: 'none' };
    return { kind: 'io_error', error: err };
  }

  // 从尾向前找第一个字段数 >= 2 的合法行
  for (let i = lines.length - 1; i >= 0; i--) {
    const parts = lines[i].split('\t');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      // NEW phase 1125: 兼容 seq=N col（ts 后第 1 col）
      let typeIdx = 1;
      if (parts[1].startsWith('seq=') && parts.length >= 3) {
        typeIdx = 2;
      }
      return { kind: 'found', event: { ts: parts[0], type: parts[typeIdx], cols: parts.slice(typeIdx + 1) } };
    }
  }
  return { kind: 'none' };
}
