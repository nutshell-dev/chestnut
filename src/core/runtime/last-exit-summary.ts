/**
 * Last-exit summary (Runtime startup helper)
 *
 * 读 audit.tsv 最后一行，把上次进程退出状态翻译成给 LLM 看的人话，
 * 用作 DialogStore.repair 的 interruptionMessage。
 *
 * 模块归属：业务层（src/core）—— 文本解读包含 daemon_stop / daemon_crash /
 * daemon_unclean_exit 等业务事件语义，不归 L2 audit foundation。
 *
 * 设计：经 L1 FileSystem 抽象 / 用 readBytesSync(start, end) 实现 tail bytes 读 /
 * 同 phase455 bypass cluster 治理一致 / phase460 cluster 6/6 全闭里程碑。
 */

import { isFileNotFound, type FileSystem } from '../../foundation/fs/types.js';

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
export function readLastExitEvent(fs: FileSystem, auditPath: string): RawEvent | null {
  let lines: string[];
  try {
    if (!fs.existsSync(auditPath)) return null;
    const stat = fs.statSync(auditPath);
    if (stat.size === 0) return null;

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
    // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
    if (!isFileNotFound(err)) {
      // last-exit-summary 是 pure helper / 0 audit writer / 失败 silent 接受
      // 影响仅 = interruptionMessage null / DialogStore.repair 仍 OK / startup-only
      // phase 904 / r115 O fork P2 re-eval: γ accepted-stable confirmed（caller DialogStore.repair audit cover repair attempt、不引 audit dep 保 ML#8）
    }
    return null;
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
      return { ts: parts[0], type: parts[typeIdx], cols: parts.slice(typeIdx + 1) };
    }
  }
  return null;
}

/**
 * 跨进程 audit.tsv 消费场景：Runtime 启动期解读上次 daemon 退出 audit / 给 LLM 中断说明。
 *
 * 设计：直用字符串字面量匹配（不 import ASSEMBLY_AUDIT_EVENTS const）/ 避免 L5 → L6 反向 dep 违 M#5。
 * audit.tsv 的 event 字符串值是跨进程契约（同 phase 393 测试字符串值断言模式）。
 * Assembly side event 字符串值改时 / 本处需同步 / 测试覆盖（last-exit-summary.test.ts）会 fail 暴露。
 */
export function summarizeLastExit(fs: FileSystem, auditPath: string): string | null {
  const ev = readLastExitEvent(fs, auditPath);
  if (!ev) return null;

  const colsText = ev.cols.length > 0 ? ` (${ev.cols.join(', ')})` : '';

  switch (ev.type) {
    case 'daemon_stop':                              // phase 454: 跨进程 audit.tsv 字符串契约 / 不 import const
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
