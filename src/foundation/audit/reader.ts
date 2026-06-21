/**
 * @module L2.AuditLog
 * AuditLog reader API (L2)
 *
 * 审计日志只读接口。与 writer.ts 解耦、独立文件。
 * 消费者：CLI query/info subcommand（本 phase Step B/C）。
 *
 * Invariants:
 * - reader 不 emit audit event（read-only、ML 5）
 * - reader 不知业务语义（cols 透传 string[]）
 * - 坏行 stderr warn + skip + continue（DP「不静默忽略」）
 * - follow rotation handover 不丢 row
 */

import * as path from 'path';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs';
import type { FileSystem } from '../fs/index.js';
import {
  lookupContentByToolUseId,
  type LookupResult,
  type LookupOptions,
} from '../dialog-store/lookup.js';
import { DIALOG_DIR } from '../dialog-store/dirs.js';

/** Compile-time brand field — prevents structural matching of mocks. */
export type { LookupResult, LookupOptions };

export interface AuditReader {
  readonly __brand: 'AuditReader';

  /**
   * Read records matching opts. Single-shot iteration.
   * Malformed rows → stderr warn + skip + continue.
   */
  read(opts?: ReadOptions): AsyncIterableIterator<AuditRecord>;

  /**
   * Follow file: yield existing records, then watch for new appends.
   * Handles rotation transparently.
   * Caller terminates via close() or SIGINT.
   */
  follow(opts?: ReadOptions): AsyncIterableIterator<AuditRecord>;

  /** Stop active follow watcher. Idempotent. */
  close(): void;

  /**
   * Lookup full tool content via tool_use_id (phase 147 §5.D 4 级降级路径).
   *
   * Wrapper that delegates to dialog-store `lookupContentByToolUseId`.
   * Reader does not own dialog content; dialog-store is SoT (M#3 + M#5).
   */
  lookupContent(toolUseId: string, options?: LookupOptions): LookupResult;
}

export interface AuditRecord {
  ts: string;
  seq: number;
  type: string;
  cols: readonly string[];
  trace_id?: string;

  // phase 147 typed ID 字段（按 phase 140 AggregatedIdNamingMap 解析）
  toolUseId?: string;      // from `tool_use_id=X` col
  stepNumber?: number;      // from `step=N` col
  contractId?: string;      // from `contract_id=X` col
  subtaskId?: string;       // from `subtask_id=X` col
  contentSize?: number;     // from `content_size=N` col
}

export interface ReadOptions {
  fromSeq?: number;
  toSeq?: number;
  sinceTs?: string;
  untilTs?: string;
  typePattern?: string;
  colFilter?: Readonly<Record<string, string>>;
  traceId?: string;
  limit?: number;

  // phase 147 typed filter（与 colFilter 等价语义、typed 优先编译期 check）
  toolUseId?: string;
  stepNumber?: number;
  contractId?: string;
  subtaskId?: string;
}

export interface AuditFileInfo {
  name: string;
  path: string;
  isBusinessMain: boolean;
}

export interface PendingFallbackDump {
  path: string;
  pid: number;
  ts: number;
  size: number;
}

/** Factory: new reader bound to a file path. */
export function createAuditReader(
  fs: FileSystem,
  filePath: string,
  options?: { dialogDir?: string },
): AuditReader {
  let closed = false;
  let watcher: ReturnType<typeof setInterval> | null = null;

  const dialogDir = options?.dialogDir ?? deriveDialogDir(filePath);

  async function *read(opts: ReadOptions = {}): AsyncIterableIterator<AuditRecord> {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readSync(filePath);
    yield* parseContent(content, opts);
  }

  async function *follow(opts: ReadOptions = {}): AsyncIterableIterator<AuditRecord> {
    if (closed) return;

    let currentPath = filePath;
    let lastSize = 0;
    let yielded = 0;
    const limit = opts.limit;

    // Initial state: read existing content if file exists
    if (fs.existsSync(currentPath)) {
      const stat = fs.statSync(currentPath);
      lastSize = stat.size;
      if (opts.fromSeq !== undefined || opts.sinceTs !== undefined) {
        // Filtered read of existing content
        for await (const rec of read(opts)) {
          if (closed) return;
          yield rec;
          yielded++;
          if (limit !== undefined && yielded >= limit) return;
        }
      } else {
        // Skip existing content when no fromSeq/sinceTs — start from EOF
      }
    }

    // Polling loop
    while (!closed) {
      // phase 528 (review-round4 Foundation L): 拆成 5 段 20ms 让 close 后最多
      // 20ms 即可 break、防原 sleep(100) 不可取消、close 后仍 wait full 100ms
      for (let i = 0; i < 5 && !closed; i++) await sleep(20);
      if (closed) return;

      if (!fs.existsSync(currentPath)) {
        continue;
      }

      const stat = fs.statSync(currentPath);
      const currentSize = stat.size;

      if (currentSize < lastSize) {
        // File shrunk or rotated: check for .bak
        const dir = path.dirname(currentPath);
        const base = path.basename(currentPath);
        const bakPrefix = `${base}.`;
        const bakSuffix = '.bak';
        let newestBakPath: string | null = null;
        let newestBakMtimeMs = -1;
        try {
          for (const entry of fs.listSync(dir)) {
            const n = entry.name;
            // 接受两形：legacy ${base}.bak 与 phase 1+ ${base}.<uuid>.bak。
            if (!n.startsWith(bakPrefix) || !n.endsWith(bakSuffix)) continue;
            const p = path.join(dir, n);
            const s = fs.statSync(p);
            const mt = s.mtime instanceof Date ? s.mtime.getTime() : 0;
            if (mt > newestBakMtimeMs) {
              newestBakMtimeMs = mt;
              newestBakPath = p;
            }
          }
        } catch {
          // silent: dir read failure during follow() polling is best-effort — no bak handover this round, next poll iteration retries naturally
        }
        if (newestBakPath && fs.existsSync(newestBakPath)) {
          // Rotation: read tail of newest .bak if any, then switch to new file
          const bakStat = fs.statSync(newestBakPath);
          if (bakStat.size > lastSize) {
            const bakContent = fs.readSync(newestBakPath);
            const tail = bakContent.slice(lastSize);
            for (const rec of parseChunk(tail, opts)) {
              if (closed) return;
              yield rec;
              yielded++;
              if (limit !== undefined && yielded >= limit) return;
            }
          }
        }
        // Reset to new file beginning (or EOF if we only want new appends)
        lastSize = 0;
        // Re-read from start to catch any new content
        if (currentSize > 0) {
          const content = fs.readSync(currentPath);
          const chunk = content.slice(0, currentSize);
          for (const rec of parseChunk(chunk, opts)) {
            if (closed) return;
            yield rec;
            yielded++;
            if (limit !== undefined && yielded >= limit) return;
          }
          lastSize = currentSize;
        }
        continue;
      }

      if (currentSize > lastSize) {
        const content = fs.readSync(currentPath);
        const chunk = content.slice(lastSize, currentSize);
        for (const rec of parseChunk(chunk, opts)) {
          if (closed) return;
          yield rec;
          yielded++;
          if (limit !== undefined && yielded >= limit) return;
        }
        lastSize = currentSize;
      }
    }
  }

  function close(): void {
    closed = true;
    if (watcher) {
      clearInterval(watcher);
      watcher = null;
    }
  }

  return {
    __brand: 'AuditReader' as const,
    read,
    follow,
    close,
    lookupContent(toolUseId: string, lookupOpts?: LookupOptions): LookupResult {
      return lookupContentByToolUseId(fs, dialogDir, toolUseId, lookupOpts);
    },
  };
}

function deriveDialogDir(auditFilePath: string): string {
  // audit filePath: <baseDir>/audit.tsv → dialogDir = <baseDir>/dialog
  return path.join(path.dirname(auditFilePath), DIALOG_DIR);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function *parseContent(content: string, opts: ReadOptions): Generator<AuditRecord> {
  const lines = content.split('\n');
  let yielded = 0;
  for (const line of lines) {
    if (!line) continue;
    const rec = parseLine(line);
    if (!rec) continue;
    if (!matchesOpts(rec, opts)) continue;
    yield rec;
    yielded++;
    if (opts.limit !== undefined && yielded >= opts.limit) return;
  }
}

// phase 369 §4 (review-2026-06-13): ISO date prefix shape check, century-agnostic.
// 旧 `chunk.startsWith('20')` 仅识别 2000-2099 年（Y2100 失效 + 历史 1900s import 也不识）。
// regex 验 YYYY-MM-DD 前缀，覆盖任意四位年份。
const ISO_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

function *parseChunk(chunk: string, opts: ReadOptions): Generator<AuditRecord> {
  // chunk may start in the middle of a line; skip to first newline unless at start
  let start = 0;
  if (chunk.length > 0 && chunk[0] !== '\n' && !ISO_DATE_PREFIX_RE.test(chunk)) {
    // Heuristic: if chunk doesn't start with an ISO date timestamp,
    // skip to first newline to avoid partial line.
    const firstNl = chunk.indexOf('\n');
    if (firstNl === -1) return; // no complete line
    start = firstNl + 1;
  }
  const lines = chunk.slice(start).split('\n');
  let yielded = 0;
  for (const line of lines) {
    if (!line) continue;
    const rec = parseLine(line);
    if (!rec) continue;
    if (!matchesOpts(rec, opts)) continue;
    yield rec;
    yielded++;
    if (opts.limit !== undefined && yielded >= opts.limit) return;
  }
}

function parseLine(line: string): AuditRecord | null {
  const parts = line.split('\t');
  if (parts.length < 3) {
    process.stderr.write(`[audit-reader] malformed row skipped: ${line.slice(0, 80)}\n`);
    return null;
  }
  const ts = parts[0];
  if (!parts[1].startsWith('seq=')) {
    process.stderr.write(`[audit-reader] missing seq col: ${line.slice(0, 80)}\n`);
    return null;
  }
  const seq = parseInt(parts[1].slice(4), 10);
  if (Number.isNaN(seq)) {
    process.stderr.write(`[audit-reader] invalid seq: ${line.slice(0, 80)}\n`);
    return null;
  }
  const type = unesc(parts[2]);
  const restCols = parts.slice(3).map(unesc);

  let traceId: string | undefined;
  if (restCols.length > 0 && restCols[restCols.length - 1].startsWith('trace_id=')) {
    traceId = restCols[restCols.length - 1].slice(9);
    restCols.pop();
  }

  // phase 147: 扫 cols 提取 typed ID 字段
  let toolUseId: string | undefined;
  let stepNumber: number | undefined;
  let contractId: string | undefined;
  let subtaskId: string | undefined;
  let contentSize: number | undefined;

  for (const col of restCols) {
    const eqIdx = col.indexOf('=');
    if (eqIdx === -1) continue;
    const colName = col.slice(0, eqIdx);
    const colValue = col.slice(eqIdx + 1);

    switch (colName) {
      case 'tool_use_id':
        toolUseId = colValue;
        break;
      case 'step': {
        const n = parseInt(colValue, 10);
        if (Number.isFinite(n)) stepNumber = n;
        break;
      }
      case 'contract_id':
        contractId = colValue;
        break;
      case 'subtask_id':
        subtaskId = colValue;
        break;
      case 'content_size': {
        const n = parseInt(colValue, 10);
        if (Number.isFinite(n)) contentSize = n;
        break;
      }
    }
  }

  return {
    ts, seq, type, cols: Object.freeze(restCols),
    trace_id: traceId,
    toolUseId, stepNumber, contractId, subtaskId, contentSize,
  };
}

function matchesOpts(rec: AuditRecord, opts: ReadOptions): boolean {
  if (opts.fromSeq !== undefined && rec.seq < opts.fromSeq) return false;
  if (opts.toSeq !== undefined && rec.seq > opts.toSeq) return false;
  if (opts.sinceTs && rec.ts < opts.sinceTs) return false;
  if (opts.untilTs && rec.ts > opts.untilTs) return false;
  if (opts.typePattern && !globMatch(rec.type, opts.typePattern)) return false;
  if (opts.traceId && rec.trace_id !== opts.traceId) return false;
  if (opts.colFilter) {
    for (const [key, val] of Object.entries(opts.colFilter)) {
      const needle = `${key}=${val}`;
      if (!rec.cols.some(c => c.includes(needle))) return false;
    }
  }

  // phase 147 typed filter（AND 语义、与 colFilter 同传时叠加）
  if (opts.toolUseId !== undefined && rec.toolUseId !== opts.toolUseId) return false;
  if (opts.stepNumber !== undefined && rec.stepNumber !== opts.stepNumber) return false;
  if (opts.contractId !== undefined && rec.contractId !== opts.contractId) return false;
  if (opts.subtaskId !== undefined && rec.subtaskId !== opts.subtaskId) return false;

  return true;
}

function globMatch(s: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  );
  return regex.test(s);
}

/** Reverse of esc() from _helpers.ts */
function unesc(s: string): string {
  return s
    .replace(/\\0/g, '\0')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

/** List audit files at baseDir. */
export function listAuditFiles(fs: FileSystem, baseDir: string): AuditFileInfo[] {
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.listSync(baseDir);
  const results: AuditFileInfo[] = [];
  for (const e of entries) {
    if (!e.name.endsWith('.tsv')) continue;
    if (e.name.includes('.bak')) continue;
    const name = e.name.slice(0, -4);
    results.push({
      name,
      path: path.join(baseDir, e.name),
      isBusinessMain: name === 'audit',
    });
  }
  // Sort: business main first, then alphabetical
  results.sort((a, b) => {
    if (a.isBusinessMain && !b.isBusinessMain) return -1;
    if (!a.isBusinessMain && b.isBusinessMain) return 1;
    return a.name.localeCompare(b.name);
  });
  return results;
}

/** Detect pending fallback dump files at OS tmpdir. */
export function listPendingFallbackDumps(): PendingFallbackDump[] {
  const tmp = tmpdir();
  const pattern = /^chestnut-audit-fallback-(\d+)-(\d+)\.tsv$/;
  let entries: string[];
  try {
    entries = nodeFs.readdirSync(tmp);
  } catch {
    return [];
  }
  const results: PendingFallbackDump[] = [];
  for (const name of entries) {
    const m = name.match(pattern);
    if (!m) continue;
    const fullPath = path.join(tmp, name);
    try {
      const stat = nodeFs.statSync(fullPath);
      results.push({
        path: fullPath,
        pid: parseInt(m[1], 10),
        ts: parseInt(m[2], 10),
        size: stat.size,
      });
    } catch { /* silent: race condition, file may disappear between readdir and stat */ }
  }
  return results;
}
