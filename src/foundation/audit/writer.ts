/**
 * @module L2a.AuditLog
 * @layer L2 基础层
 *
 * 审计日志追加写、模块级 fallback 池兜底崩溃路径。
 *
 * **设计意图：模块级 fallback 池共享**
 *
 * `pendingFallback` array + drop counter 是 module-scope 变量、所有 `AuditWriter` 实例共享。
 * 设计动机：
 * - **崩溃兜底**：主写入路径失败时、所有 writer 共享同一 fallback 队列、统一 dump 到 /tmp/chestnut-audit-fallback-*.tsv
 * - **跨实例 reconcile**：daemon 重启后 `reconcileFallbackDumps` 扫所有 dump、回放至各对应 audit.tsv（per-file partition by origin frontmatter）
 * - **drop 计数全局聚合**：buffer overflow 时 FIFO drop 累计 counter、不分实例、便于 frontmatter 观测
 *
 * 多实例隔离：每 AuditWriter 实例 own 自家 `filePath` + `sequence` 状态、不共享。
 * 共享部分仅限崩溃路径的 fallback 池。
 *
 * phase 1380 加 drop 观测性、phase 1374 加 reconcile fsync、phase 908 加 TOCTOU race-loser skip。
 *
 * Resources: audit.tsv
 * Dependencies: FileSystem
 * Coupling: none
 * Consumers: Daemon, Runtime, ContractSystem, SubagentSystem
 *
 * 递归边界：AuditWriter 自身 write/rotation 失败是"审计的审计"死角，
 * 无法进入结构化事件流（会无限递归），唯一兜底是 console.error
 * 以 [AUDIT CRITICAL] 前缀输出。这是 L2 层唯一允许保留的 console 出口
 * （依赖 AuditLog 的其他 L2 模块不得效仿）。
 */

import { newShortUuid } from  '../node-utils/index.js';
import { formatErr } from "../node-utils/index.js";
import type { TraceId } from './types.js';
import * as nodeFs from 'node:fs';
import * as nodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FileNotFoundError } from '../fs/index.js';
import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from './types.js';
import { esc, clipPreview, clipMessage, clipSummary } from './_helpers.js';

export const FALLBACK_BUFFER_CAP = 1000;
const FALLBACK_FRONTMATTER_PREFIX = '# drop_count_since_last_dump=';
function getFallbackDir(): string { return tmpdir(); }
interface FallbackEntry {
  origin: string;
  line: string;
}
const pendingFallback: FallbackEntry[] = [];
let exitHandlerInstalled = false;
let overflowMetaEmitted = false;
// phase 367: 单次 setTimeout 替原 setInterval flushTimer; pushFallback trigger 一次、多 push 共用
let flushMaxLatencyTimer: ReturnType<typeof setTimeout> | null = null;
const FALLBACK_FLUSH_LATENCY_MS = 5000;  // 同原 5s tick

// phase 1380: drop observability counters (phase 586 D1.b ratify 顺延 + observability 补完)
let dropCountTotal = 0;            // module-level、never reset (process lifetime)
let dropCountSinceLastDump = 0;    // reset after successful dump
let firstDropTs: number | null = null;
let lastDropTs: number | null = null;

function ensureExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', dumpFallback);
}

export function pushFallback(line: string, origin: string): void {
  if (pendingFallback.length >= FALLBACK_BUFFER_CAP) {
    pendingFallback.shift();   // FIFO drop-oldest (phase 586 D1.b ratify 不动)
    dropCountTotal++;
    dropCountSinceLastDump++;
    const now = Date.now();
    if (firstDropTs === null) firstDropTs = now;
    lastDropTs = now;
    if (!overflowMetaEmitted) {
      overflowMetaEmitted = true;
      console.error(
        `[AUDIT CRITICAL] fallback buffer overflow (cap=${FALLBACK_BUFFER_CAP}), oldest entries dropped — drop counts accumulating to next fallback dump frontmatter`,
      );
    }
  }
  pendingFallback.push({ origin, line });
  ensureExitHandler();
  ensurePeriodicFlush();
}

/**
 * phase 367 event-driven flush scheduling (替原 setInterval 5s):
 * - 仅首次 pushFallback trigger 一次 setTimeout(FALLBACK_FLUSH_LATENCY_MS)
 * - 后续 pushFallback 共用 timer；dump 内 clear timer；新 push 再 schedule
 */
function ensurePeriodicFlush(): void {
  if (flushMaxLatencyTimer) return;
  flushMaxLatencyTimer = setTimeout(() => {
    flushMaxLatencyTimer = null;
    dumpFallback();
  }, FALLBACK_FLUSH_LATENCY_MS);
  flushMaxLatencyTimer.unref();
}

function dumpFallback(): void {
  if (pendingFallback.length === 0 && dropCountSinceLastDump === 0) return;
  const batch = pendingFallback.splice(0); // atomic: clear + capture
  // phase 1380: drop metadata frontmatter (旧文件无此行、reconcile parser 兼容)
  const dropFrontmatter = dropCountSinceLastDump > 0
    ? `${FALLBACK_FRONTMATTER_PREFIX}${dropCountSinceLastDump} drop_count_total=${dropCountTotal} first_drop_ts=${firstDropTs} last_drop_ts=${lastDropTs}\n`
    : '';
  let written = false;
  try {
    const fallbackPath = `${getFallbackDir()}/chestnut-audit-fallback-${process.pid}-${Date.now()}.tsv`;
    // origin 作 synthetic col 0 prepend / esc(origin) 防 tab 污染
    const body = batch
      .map(e => `${esc(e.origin)}\t${e.line}`)
      .join('');
    nodeFs.writeFileSync(fallbackPath, dropFrontmatter + body);
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
      const reason = formatErr(syncErr);
      console.error(
        `[AUDIT WARNING] fallback fsync failed: path=${fallbackPath} reason=${reason}`,
      );
    }
    // phase 1380: 成功 dump 后 reset since-last，total 维持
    dropCountSinceLastDump = 0;
    firstDropTs = null;
    lastDropTs = null;
  } catch (err) {
    // write 失败：恢复 entries 到 buffer（best-effort、顺序非关键）
    if (!written) {
      pendingFallback.unshift(...batch);
      // drop counter 不动（dropCountSinceLastDump 维持、下次 dump 重试 frontmatter）
    }
    const reason = formatErr(err);
    console.error(
      `[AUDIT CRITICAL] fallback dump failed: reason=${reason} pending=${pendingFallback.length}`,
    );
    // phase 367: 失败重试：重新 schedule timer
    if (pendingFallback.length > 0) ensurePeriodicFlush();
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
const FRONTMATTER_RE = /^# drop_count_since_last_dump=(\d+) drop_count_total=(\d+) first_drop_ts=(\d+) last_drop_ts=(\d+)$/;

export async function reconcileFallbackDumps(fs: FileSystem): Promise<void> {
  const tmp = getFallbackDir();
  const pattern = /^chestnut-audit-fallback-\d+-\d+\.tsv$/;
  // phase 1115 Step A: tmpdir 操作走 raw node:fs（与 dumpFallback 写路径同 boundary、phase 1214 ratify）——
  // 注入 fs 是 clawDir-scoped、path guard 必拒 tmpdir；origin 回放（clawDir 内）仍走注入 fs。
  let names: string[];
  try {
    names = nodeFs.readdirSync(tmp);
  } catch (listErr) {
    console.error(`[AUDIT WARNING] reconcile fallback list failed: tmp=${tmp} reason=${formatErr(listErr)}`);
    return;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const dumpPath = `${tmp}/${name}`;
    try {
      const content = nodeFs.readFileSync(dumpPath, 'utf8');
      const allLines = content.split('\n');
      let dropMeta: { since: number; total: number; first: number; last: number } | null = null;
      let frontmatterRaw: string | null = null;
      // phase 1380: detect optional frontmatter (旧文件首行不以 prefix 起、跳过)
      if (allLines[0] && allLines[0].startsWith(FALLBACK_FRONTMATTER_PREFIX)) {
        const m = allLines[0].match(FRONTMATTER_RE);
        if (m) {
          frontmatterRaw = allLines[0] + '\n';
          dropMeta = { since: +m[1], total: +m[2], first: +m[3], last: +m[4] };
          allLines.shift();
        }
      }
      const byOrigin = new Map<string, string[]>();
      for (const line of allLines) {
        if (!line) continue;
        const tabIdx = line.indexOf('\t');
        if (tabIdx === -1) continue;
        const origin = line.slice(0, tabIdx);
        const rest = line.slice(tabIdx + 1);
        let lines = byOrigin.get(origin);
        if (!lines) { lines = []; byOrigin.set(origin, lines); }
        lines.push(rest);
      }
      const failedOrigins = new Map<string, string[]>();
      for (const [origin, lines] of byOrigin) {
        try {
          await fs.appendSync(origin, lines.join('\n') + '\n');
          // phase 1374 sub-4: ensure recovery data is truly persisted (fsync)
          try {
            fs.syncSync(origin);
          } catch (syncErr) {
            const reason = formatErr(syncErr);
            console.error(`[AUDIT WARNING] reconcile fallback fsync failed: origin=${origin} reason=${reason}`);
          }
          // phase 1380: drop metadata audit emit per origin
          if (dropMeta && dropMeta.since > 0) {
            // phase 689: 加 origin= 第 1 col、forensic 解析时无需依赖写入文件位置反推 origin
            const dropLine = `audit_fallback_dropped\torigin=${origin}\tdrop_count=${dropMeta.since}\tdrop_count_total=${dropMeta.total}\tfirst_drop_ts=${dropMeta.first}\tlast_drop_ts=${dropMeta.last}\n`;
            try {
              await fs.appendSync(origin, dropLine);
              try { fs.syncSync(origin); } catch (_) { /* silent: fsync best-effort */ }
            } catch (_) { /* silent: per-origin best-effort */ }
          }
        } catch (perOriginErr) {
          // phase 426 Step A (review medium silent-catch): inner 失败可能 PermissionError /
          // 文件被删；console.error 留痕、不依赖 audit 防递归 (我们正在 reconcile audit 自身)。
          failedOrigins.set(origin, lines);
          console.error(`[AUDIT WARNING] reconcile fallback per-origin write failed: origin=${origin} reason=${formatErr(perOriginErr)}`);
        }
      }
      // phase 1115 Step B: 完全成功才删 dump；失败 origin 重写回 dump 供下轮重试。
      if (failedOrigins.size === 0) {
        nodeFs.unlinkSync(dumpPath);
      } else {
        try {
          const body = [...failedOrigins]
            .map(([origin, lines]) => lines.map(line => `${esc(origin)}\t${line}\n`).join(''))
            .join('');
          const next = `${dumpPath}.next`;
          await nodeFsPromises.writeFile(next, (frontmatterRaw ?? '') + body);
          try {
            const fd = nodeFs.openSync(next, 'r+');
            try { nodeFs.fsyncSync(fd); } finally { nodeFs.closeSync(fd); }
          } catch { /* silent: fsync best-effort（与 dumpFallback 同边界） */ }
          nodeFs.renameSync(next, dumpPath);
        } catch (rewriteErr) {
          console.error(`[AUDIT WARNING] reconcile fallback dump rewrite failed: dumpPath=${dumpPath} reason=${formatErr(rewriteErr)}`);
          // 重写失败 → 原 dump 保留全量、下轮重试（best-effort 边界）
        }
        console.error(`[AUDIT WARNING] reconcile fallback dump kept for retry: dumpPath=${dumpPath} failed_origins=${failedOrigins.size}`);
      }
    } catch (dumpErr) {
      // phase 426 Step A (review medium silent-catch): outer dump 解析失败 (corrupt /
      // PermissionError on read)；console.error 留痕、下轮 reconcile 重试。
      console.error(`[AUDIT WARNING] reconcile fallback dump skipped: dumpPath=${dumpPath} reason=${formatErr(dumpErr)}`);
    }
  }
}

/** audit.tsv 相对路径 */
// AUDIT_FILE 是文件名（相对路径），不含目录。
// 调用方负责通过 fs.baseDir 或 createSystemAudit helper 拼接完整路径。
export const AUDIT_FILE = 'audit.tsv';

export class AuditWriter implements AuditLog {
  readonly __brand = 'AuditLog' as const;
  private readonly maxBytes: number | null;
  private seq = 0; // NEW phase 1125
  /** phase 1343 α-6: turn-level trace id for cross-module audit correlation */
  traceId?: TraceId;

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
    if (this.traceId) {
      parts.push(`trace_id=${esc(this.traceId)}`);
    }
    const line = parts.join('\t') + '\n';
    try {
      if (this.maxBytes) this.rotateIfNeeded();
      this.fs.appendSync(this.filePath, line);
      try {
        this.fs.syncSync(this.filePath);
      } catch (syncErr) {
        const reason = formatErr(syncErr);
        console.error(`[AUDIT WARNING] sync failed: type=${type} path=${this.filePath} reason=${reason}`);
      }
    } catch (err) {
      const reason = formatErr(err);
      console.error(`[AUDIT CRITICAL] write failed: type=${type} path=${this.filePath} reason=${reason}`);
      pushFallback(line, this.filePath);
    }
  }

  dispose(): void {
    dumpFallback();
  }

  preview(s: string): string { return clipPreview(s); }
  message(s: string): string { return clipMessage(s); }
  summary(s: string): string { return clipSummary(s); }

  private rotateIfNeeded(): void {
    try {
      const stats = this.fs.statSync(this.filePath);
      if (stats.size >= this.maxBytes!) {
        this.fs.moveSync(this.filePath, `${this.filePath}.${newShortUuid()}.bak`);
      }
    } catch (err) {
      // FileNotFoundError（首次写入文件不存在 from statSync）或 raw NodeJS ENOENT
      // （TOCTOU race-loser from moveSync 当文件已被外部 rotate / cleanup）静默跳过；
      // 其他 errno 仍 warn
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!(err instanceof FileNotFoundError) && code !== 'ENOENT') {
        const reason = formatErr(err);
        console.error(`[AUDIT CRITICAL] rotation check failed: path=${this.filePath} reason=${reason}`);
      }
    }
  }
}

/** Test-only: reset module-level fallback state (do not call in production) */
export function _resetFallbackForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetFallbackForTest is for tests only');
  }
  pendingFallback.length = 0;
  exitHandlerInstalled = false;
  overflowMetaEmitted = false;
  // phase 1380: reset drop counters for test isolation
  dropCountTotal = 0;
  dropCountSinceLastDump = 0;
  firstDropTs = null;
  lastDropTs = null;
  // phase 367: 清 maxLatency timer (替原 flushTimer)
  if (flushMaxLatencyTimer) {
    clearTimeout(flushMaxLatencyTimer);
    flushMaxLatencyTimer = null;
  }
}

