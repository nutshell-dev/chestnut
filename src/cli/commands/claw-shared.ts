/**
 * @module L6.CLI.Claw.Shared
 * Helpers shared by listCommand + healthCommand
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { readAll, STREAM_FILE, LLM_OUTPUT_EVENTS } from '../../foundation/stream/index.js';

/**
 * Format relative time (milliseconds to a human-readable string)
 */
export function formatRelativeTime(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h`;
}

// LLM 输出事件类型（re-export from canonical stream module / single source per phase 1003）
export { LLM_OUTPUT_EVENTS };

/**
 * phase 540: formatClawStatusHint + formatNoActiveContractHint 迁出至 foundation/utils
 * (assembly → cli 反向 import 消除 / pure formatter 归 L1 utils 叶子). 本文件 re-export
 * 保 cli 内部 callsite 兼容、不动迁移期间的 cli 内部 import 路径.
 */
export { formatClawStatusHint, formatNoActiveContractHint } from '../../foundation/utils/index.js';

/**
 * 从 stream.jsonl 读取最后活跃时间（统一与 watchdog 指标）
 */
export async function getLastActiveMs(clawFs: FileSystem, audit: AuditLog): Promise<number | undefined> {
  try {
    const events = await readAll(clawFs, STREAM_FILE, audit);
    let last: number | undefined;
    for (const ev of events) {
      if (LLM_OUTPUT_EVENTS.has(ev.type) && typeof ev.ts === 'number') {
        last = ev.ts;
      }
    }
    return last;
  } catch { return undefined; }
}
