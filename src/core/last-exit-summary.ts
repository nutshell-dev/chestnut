/**
 * Last-exit summary (Runtime startup helper)
 *
 * 读 audit.tsv 最后一行，把上次进程退出状态翻译成给 LLM 看的人话，
 * 用作 SessionStore.repair 的 interruptionMessage。
 *
 * 模块归属：业务层（src/core）—— 文本解读包含 daemon_stop / daemon_crash /
 * daemon_unclean_exit 等业务事件语义，不归 L2 audit foundation。
 *
 * 设计：直接走 node fs sync API（绕过 FileSystem 抽象）—— 启动时一次性
 * 操作，且"读尾部 N 字节"语义不在 FileSystem 接口范围内。与 daemon.ts
 * detectUncleanExit 同型设计。
 */

import * as fs from 'fs';

const TAIL_BYTES = 4096;

interface RawEvent {
  ts: string;
  type: string;
  cols: string[];
}

/**
 * 读取 audit.tsv 的最后一行非空记录。
 *
 * @returns 解析后的 raw event；文件不存在 / 空 / 全部坏行 → null
 */
export function readLastExitEvent(auditPath: string): RawEvent | null {
  let lines: string[];
  try {
    if (!fs.existsSync(auditPath)) return null;
    const stat = fs.statSync(auditPath);
    if (stat.size === 0) return null;

    if (stat.size <= TAIL_BYTES) {
      lines = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean);
    } else {
      const offset = stat.size - TAIL_BYTES;
      const fd = fs.openSync(auditPath, 'r');
      try {
        const buf = Buffer.alloc(TAIL_BYTES);
        fs.readSync(fd, buf, 0, TAIL_BYTES, offset);
        const chunk = buf.toString('utf-8');
        // 切掉首段不完整行（offset 落在某行中间的可能）
        const newlineIdx = chunk.indexOf('\n');
        const safeChunk = newlineIdx >= 0 ? chunk.slice(newlineIdx + 1) : chunk;
        lines = safeChunk.split('\n').filter(Boolean);
        // 极端情况：单行长度 > TAIL_BYTES，safeChunk 拿不到完整行，回退全读
        if (lines.length === 0) {
          lines = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean);
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.warn('[last-exit-summary] Failed to read audit:', err?.code || err?.message || err);
    }
    return null;
  }

  // 从尾向前找第一个字段数 >= 2 的合法行
  for (let i = lines.length - 1; i >= 0; i--) {
    const parts = lines[i].split('\t');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return { ts: parts[0], type: parts[1], cols: parts.slice(2) };
    }
  }
  return null;
}

/**
 * 把 audit.tsv 最后一行翻译为给 LLM 看的中断说明文本。
 *
 * @returns 解读文本，或 null 表示无信息可反查
 */
export function summarizeLastExit(auditPath: string): string | null {
  const ev = readLastExitEvent(auditPath);
  if (!ev) return null;

  const colsText = ev.cols.length > 0 ? ` (${ev.cols.join(', ')})` : '';

  switch (ev.type) {
    case 'daemon_stop':
      return `Last process stopped normally at ${ev.ts}${colsText}.`;
    case 'daemon_crash':
      return `Last process crashed at ${ev.ts}${colsText}.`;
    case 'daemon_unclean_exit':
      return `Last process exited uncleanly at ${ev.ts} (likely SIGKILL / OOM / power loss; no graceful shutdown).${
        ev.cols.length > 0 ? ` Last activity timestamp: ${ev.cols.join(', ')}.` : ''
      }`;
    default:
      return `Last process did not write a shutdown event. Last recorded activity at ${ev.ts} was '${ev.type}'${colsText}.`;
  }
}
