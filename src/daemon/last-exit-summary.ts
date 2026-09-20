/**
 * Last-exit summary (Daemon startup helper)
 *
 * 把上次进程退出状态翻译成给 LLM 看的人话，用作 DialogStore.repair 的
 * interruptionMessage。
 *
 * phase 1873 Step K（daemon-last-exit-bypasses-audit-owner）：不再直读/解析
 * audit.tsv——tsv 物理格式（tail 读、列切分、seq col 兼容）经 AuditLog owner 的
 * `readLastAuditEvent` 稳定 query；事件名经 owner 常量引用（daemon 事件归 daemon、
 * daemon_stop/unclean_exit 归 assembly），不硬编码字面。文案分类（LLM 可读文本）
 * 归 daemon。
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { readLastAuditEvent } from '../foundation/audit/index.js';
import { DAEMON_AUDIT_EVENTS } from './audit-events.js';
import { ASSEMBLY_AUDIT_EVENTS } from '../assembly/index.js';

/**
 * 跨进程 audit 消费：Runtime 启动期解读上次 daemon 退出 / 给 LLM 中断说明。
 * 读取失败（非 ENOENT）经 onReadError 留证、返回 null（不静默折「无记录」）。
 */
export function summarizeLastExit(
  fs: FileSystem,
  auditPath: string,
  onReadError?: (error: unknown) => void,
): string | null {
  const result = readLastAuditEvent(fs, auditPath);
  if (result.kind === 'io_error') {
    onReadError?.(result.error);
    return null;
  }
  if (result.kind === 'none') return null;
  const ev = result.event;

  const colsText = ev.cols.length > 0 ? ` (${ev.cols.join(', ')})` : '';

  switch (ev.type) {
    case ASSEMBLY_AUDIT_EVENTS.DAEMON_STOP:
      return `Last process stopped normally at ${ev.ts}${colsText}.`;
    case DAEMON_AUDIT_EVENTS.DAEMON_CRASH:
      return `Last process crashed at ${ev.ts}${colsText}.`;
    case ASSEMBLY_AUDIT_EVENTS.DAEMON_UNCLEAN_EXIT:
      return `Last process exited uncleanly at ${ev.ts} (likely SIGKILL / OOM / power loss; no graceful shutdown).${
        ev.cols.length > 0 ? ` Last activity timestamp: ${ev.cols.join(', ')}.` : ''
      }`;
    default:
      return `Last process did not write a shutdown event. Last recorded activity at ${ev.ts} was '${ev.type}'${colsText}.`;
  }
}
