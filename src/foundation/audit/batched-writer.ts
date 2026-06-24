import { newShortUuid } from  '../node-utils/index.js';
import { formatErr } from "../node-utils/index.js";
import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from './types.js';
import { pushFallback } from './writer.js';
import { esc, clipPreview, clipMessage, clipSummary } from './_helpers.js';

/**
 * BatchedAuditWriter constructor option fallback default — flush 触发的 buffer line 阈值.
 * Derivation: 50 line ≈ 一次典型 batch（1-2 turn audit）/ 平衡 fs write 频率 vs memory footprint /
 * 配合 DEFAULT_FLUSH_INTERVAL_MS (1000) 形成 size-or-time 双触发.
 */
const DEFAULT_BATCH_SIZE = 50;

/**
 * BatchedAuditWriter constructor option fallback default — periodic flush interval (ms).
 * Derivation: 1000ms = 1s 给低频 audit 写入兜底 / 配合 DEFAULT_BATCH_SIZE (50) /
 * 配 fs 写时间 ≤ 50ms 即 < 5% wall clock overhead.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 1000;


export interface BatchedAuditWriterOptions {
  maxSizeMb?: number | null;
  batchSize?: number;        // flush when buffer reaches this many lines (default DEFAULT_BATCH_SIZE = 50)
  flushIntervalMs?: number;  // periodic flush interval (default DEFAULT_FLUSH_INTERVAL_MS = 1000ms)
}

export class BatchedAuditWriter implements AuditLog {
  readonly __brand = 'AuditLog' as const;
  private buffer: string[] = [];
  // phase 367: 单次 setTimeout 替原 setInterval flushTimer; write trigger 一次、多 write 共用
  private maxLatencyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fs: FileSystem;
  private readonly filePath: string;
  private readonly maxBytes: number | null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private currentIntervalMs: number;
  private readonly maxBackoffMs = 30_000;
  private seq = 0; // NEW phase 1125

  constructor(fs: FileSystem, filePath: string, opts: BatchedAuditWriterOptions = {}) {
    this.fs = fs;
    this.filePath = filePath;
    this.maxBytes = opts.maxSizeMb ? opts.maxSizeMb * 1024 * 1024 : null;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.currentIntervalMs = this.flushIntervalMs;
  }

  write(type: string, ...cols: (string | number)[]): void {
    this.seq++;
    const ts = new Date().toISOString();
    const parts = [esc(ts), `seq=${this.seq}`, esc(type), ...cols.map(c => esc(String(c)))];
    this.buffer.push(parts.join('\t') + '\n');
    if (this.buffer.length >= this.batchSize) {
      this.flush();
      return;
    }
    if (this.buffer.length > 0) this._scheduleFlush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    try {
      if (this.maxBytes) {
        try {
          const stats = this.fs.statSync(this.filePath);
          if (stats.size >= this.maxBytes) {
            this.fs.moveSync(this.filePath, `${this.filePath}.${newShortUuid()}.bak`);
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error(
            `[AUDIT CRITICAL] batched rotation failed: path=${this.filePath} reason=${formatErr(err)}`,
          );
          }
        }
      }
      this.fs.appendSync(this.filePath, batch.join(''));
      try {
        this.fs.syncSync(this.filePath);
      } catch (syncErr) {
        // fsync failure = best-effort warning; do NOT pushFallback (avoid double-write on next reconcile)
        const reason = formatErr(syncErr);
        console.error(
          `[AUDIT WARNING] batched fsync failed: path=${this.filePath} lines=${batch.length} reason=${reason}`,
        );
      }
      // SUCCESS: reset backoff
      this.currentIntervalMs = this.flushIntervalMs;
      this._clearMaxLatency();
    } catch (err) {
      const reason = formatErr(err);
      console.error(
        `[AUDIT CRITICAL] batched flush failed: path=${this.filePath} lines=${batch.length} reason=${reason}`,
      );
      for (const line of batch) {
        pushFallback(line, this.filePath);
      }
      // FAILURE: exponential backoff applied on next _scheduleFlush
      this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.maxBackoffMs);
      this._clearMaxLatency();
    }
  }

  /**
   * phase 367 event-driven flush scheduling (替原 setInterval 周期 tick):
   * - 仅 write trigger 一次 setTimeout(currentIntervalMs)
   * - 后续 write 不重创 timer（multi-write 合一次 flush）
   * - flush 内 clear timer；新 write 再 schedule
   * - 比 setInterval 节省：idle 时无空跑、不阻 event loop（unref）
   */
  private _scheduleFlush(): void {
    if (this.maxLatencyTimer) return;  // 已 scheduled
    this.maxLatencyTimer = setTimeout(() => {
      this.maxLatencyTimer = null;
      this.flush();
    }, this.currentIntervalMs);
    this.maxLatencyTimer.unref();
  }

  private _clearMaxLatency(): void {
    if (this.maxLatencyTimer) {
      clearTimeout(this.maxLatencyTimer);
      this.maxLatencyTimer = null;
    }
  }

  /** Dispose: flush remaining + clear timer. Call on shutdown. */
  dispose(): void {
    this._clearMaxLatency();
    this.flush();
  }

  preview(s: string): string { return clipPreview(s); }
  message(s: string): string { return clipMessage(s); }
  summary(s: string): string { return clipSummary(s); }
}
