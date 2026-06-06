import { randomUUID } from 'node:crypto';
import { formatErr } from "../utils/index.js";
import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from './types.js';
import { pushFallback } from './writer.js';
import { esc } from './_helpers.js';
import { UUID_SHORT_LEN } from '../../constants.js';

/** BatchedAuditWriter constructor option fallback default — flush 触发的 buffer line 阈值 */
const DEFAULT_BATCH_SIZE = 50;

/** BatchedAuditWriter constructor option fallback default — periodic flush interval (ms) */
const DEFAULT_FLUSH_INTERVAL_MS = 1000;


export interface BatchedAuditWriterOptions {
  maxSizeMb?: number | null;
  batchSize?: number;        // flush when buffer reaches this many lines (default DEFAULT_BATCH_SIZE = 50)
  flushIntervalMs?: number;  // periodic flush interval (default DEFAULT_FLUSH_INTERVAL_MS = 1000ms)
}

export class BatchedAuditWriter implements AuditLog {
  readonly __brand = 'AuditLog' as const;
  private buffer: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
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
    }
    this._ensureTimer();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    try {
      if (this.maxBytes) {
        try {
          const stats = this.fs.statSync(this.filePath);
          if (stats.size >= this.maxBytes) {
            this.fs.moveSync(this.filePath, `${this.filePath}.${randomUUID().slice(0, UUID_SHORT_LEN)}.bak`);
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
      if (this.currentIntervalMs !== this.flushIntervalMs) {
        this.currentIntervalMs = this.flushIntervalMs;
        this._resetTimer();
      }
    } catch (err) {
      const reason = formatErr(err);
      console.error(
        `[AUDIT CRITICAL] batched flush failed: path=${this.filePath} lines=${batch.length} reason=${reason}`,
      );
      for (const line of batch) {
        pushFallback(line, this.filePath);
      }
      // FAILURE: exponential backoff timer
      this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.maxBackoffMs);
      this._resetTimer();
    }
  }

  private _ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.currentIntervalMs);
    this.timer.unref();
  }

  private _resetTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._ensureTimer();
  }

  /** Dispose: flush remaining + clear timer. Call on shutdown. */
  dispose(): void {
    this.flush();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
