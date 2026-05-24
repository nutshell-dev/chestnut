import { randomUUID } from 'crypto';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { UUID_SHORT_LEN } from '../../constants.js';
import { FileNotFoundError } from '../fs/types.js';
import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from './index.js';

const FALLBACK_BUFFER_CAP = 1000;
function getFallbackDir(): string { return tmpdir(); }
interface FallbackEntry {
  origin: string;
  line: string;
}
const pendingFallback: FallbackEntry[] = [];
let exitHandlerInstalled = false;
let overflowMetaEmitted = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', dumpFallback);
}

export function pushFallback(line: string, origin: string): void {
  if (pendingFallback.length >= FALLBACK_BUFFER_CAP) {
    pendingFallback.shift();   // FIFO drop-oldest
    if (!overflowMetaEmitted) {
      overflowMetaEmitted = true;
      console.error(
        `[AUDIT CRITICAL] fallback buffer overflow (cap=${FALLBACK_BUFFER_CAP}), oldest entries dropped`,
      );
    }
  }
  pendingFallback.push({ origin, line });
  ensureExitHandler();
  ensurePeriodicFlush();
}

function ensurePeriodicFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    dumpFallback();
  }, 5000);
  flushTimer.unref(); // 不阻 event loop 退出
}

function dumpFallback(): void {
  if (pendingFallback.length === 0) return;
  const batch = pendingFallback.splice(0); // atomic: clear + capture
  let written = false;
  try {
    const fallbackPath = `${getFallbackDir()}/clawforum-audit-fallback-${process.pid}-${Date.now()}.tsv`;
    // origin 作 synthetic col 0 prepend / esc(origin) 防 tab 污染
    const body = batch
      .map(e => `${esc(e.origin)}\t${e.line}`)
      .join('');
    nodeFs.writeFileSync(fallbackPath, body);
    written = true;
    try {
      const fd = nodeFs.openSync(fallbackPath, 'r+');
      try {
        nodeFs.fsyncSync(fd);
      } finally {
        nodeFs.closeSync(fd);
      }
    } catch (syncErr) {
      // fsync best-effort: data already written, durability warning only
      const reason = syncErr instanceof Error ? syncErr.message : String(syncErr);
      console.error(
        `[AUDIT WARNING] fallback fsync failed: path=${fallbackPath} reason=${reason}`,
      );
    }
  } catch (err) {
    // write 失败：恢复 entries 到 buffer（best-effort、顺序非关键）
    if (!written) {
      pendingFallback.unshift(...batch);
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[AUDIT CRITICAL] fallback dump failed: reason=${reason} pending=${pendingFallback.length}`,
    );
  }
}

/**
 * Boot-time: scan tmpdir for prior crash fallback dumps and append their
 * contents to the corresponding live audit.tsv files (keyed by origin col).
 * Best-effort — individual file parse/append failures are skipped.
 *
 * Race window invariant (snapshot-bounded, phase 1153 design row trace):
 * `fs.list` is a snapshot call; new fallback files written by an already-open
 * auditWriter after the snapshot are NOT read this reconcile pass — they
 * are picked up on next boot. No data loss; only one-boot latency penalty.
 * See `design/modules/l2_audit_log.md` §7.A
 * `A.phase1153-reconcile-snapshot-bounded-race-window-invariant`.
 */
export async function reconcileFallbackDumps(fs: FileSystem): Promise<void> {
  const tmp = getFallbackDir();
  const pattern = /^clawforum-audit-fallback-\d+-\d+\.tsv$/;
  let entries: { name: string }[];
  try {
    entries = await fs.list(tmp, { includeDirs: false });
  } catch {
    return; // tmpdir 不可访问 → skip
  }
  for (const entry of entries) {
    if (!pattern.test(entry.name)) continue;
    const dumpPath = `${tmp}/${entry.name}`;
    try {
      const content = await fs.read(dumpPath);
      const byOrigin = new Map<string, string[]>();
      for (const line of content.split('\n')) {
        if (!line) continue;
        const tabIdx = line.indexOf('\t');
        if (tabIdx === -1) continue;
        const origin = line.slice(0, tabIdx);
        const rest = line.slice(tabIdx + 1);
        let lines = byOrigin.get(origin);
        if (!lines) { lines = []; byOrigin.set(origin, lines); }
        lines.push(rest);
      }
      for (const [origin, lines] of byOrigin) {
        try {
          await fs.appendSync(origin, lines.join('\n') + '\n');
        } catch {
          // silent: 目标文件可能已被删 / 权限变（best-effort per-file、其他 origin 仍继续）
        }
      }
      await fs.delete(dumpPath);
    } catch {
      // silent: 损坏文件跳过、下轮 reconcile 重试（best-effort、不阻塞整体启动）
    }
  }
}

/** audit.tsv 相对路径 */
// AUDIT_FILE 是文件名（相对路径），不含目录。
// 调用方负责通过 fs.baseDir 或 createSystemAudit helper 拼接完整路径。
export const AUDIT_FILE = 'audit.tsv';

export class AuditWriter implements AuditLog {
  private readonly maxBytes: number | null;
  private seq = 0; // NEW phase 1125

  constructor(
    private readonly fs: FileSystem,
    private readonly filePath: string,
    maxSizeMb?: number | null,
  ) {
    this.maxBytes = maxSizeMb ? maxSizeMb * 1024 * 1024 : null;
  }

  write(type: string, ...cols: (string | number)[]): void {
    this.seq++;
    const ts = new Date().toISOString();
    const parts = [esc(ts), `seq=${this.seq}`, esc(type), ...cols.map(c => esc(String(c)))];
    const line = parts.join('\t') + '\n';
    try {
      if (this.maxBytes) this.rotateIfNeeded();
      this.fs.appendSync(this.filePath, line);
      try {
        this.fs.syncSync(this.filePath);
      } catch (syncErr) {
        const reason = syncErr instanceof Error ? syncErr.message : String(syncErr);
        console.error(`[AUDIT WARNING] sync failed: type=${type} path=${this.filePath} reason=${reason}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[AUDIT CRITICAL] write failed: type=${type} path=${this.filePath} reason=${reason}`);
      pushFallback(line, this.filePath);
    }
  }

  dispose(): void {
    dumpFallback();
  }

  private rotateIfNeeded(): void {
    try {
      const stats = this.fs.statSync(this.filePath);
      if (stats.size >= this.maxBytes!) {
        this.fs.moveSync(this.filePath, `${this.filePath}.${randomUUID().slice(0, UUID_SHORT_LEN)}.bak`);
      }
    } catch (err) {
      // FileNotFoundError（首次写入文件不存在 from statSync）或 raw NodeJS ENOENT
      // （TOCTOU race-loser from moveSync 当文件已被外部 rotate / cleanup）静默跳过；
      // 其他 errno 仍 warn
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!(err instanceof FileNotFoundError) && code !== 'ENOENT') {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[AUDIT CRITICAL] rotation check failed: path=${this.filePath} reason=${reason}`);
      }
    }
  }
}

/** Test-only: reset module-level fallback state (do not call in production) */
export function _resetFallbackForTest(): void {
  pendingFallback.length = 0;
  exitHandlerInstalled = false;
  overflowMetaEmitted = false;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')   // \\ 先转（防后续替换产生的 \\ 被二次转义）
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0');
}
