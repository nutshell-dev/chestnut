import { randomUUID } from 'node:crypto';
import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from './index.js';

const UUID_SHORT_LEN = 8;

function esc(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0');
}

export interface BatchedAuditWriterOptions {
  maxSizeMb?: number | null;
  batchSize?: number;        // flush when buffer reaches this many lines (default 50)
  flushIntervalMs?: number;  // periodic flush interval (default 1000ms)
}

export class BatchedAuditWriter implements AuditLog {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fs: FileSystem;
  private readonly filePath: string;
  private readonly maxBytes: number | null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  constructor(fs: FileSystem, filePath: string, opts: BatchedAuditWriterOptions = {}) {
    this.fs = fs;
    this.filePath = filePath;
    this.maxBytes = opts.maxSizeMb ? opts.maxSizeMb * 1024 * 1024 : null;
    this.batchSize = opts.batchSize ?? 50;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
  }

  write(type: string, ...cols: (string | number)[]): void {
    const ts = new Date().toISOString();
    const parts = [esc(ts), esc(type), ...cols.map(c => esc(String(c)))];
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
            console.error('Audit rotation failed:', err);
          }
        }
      }
      this.fs.appendSync(this.filePath, batch.join(''));
    } catch (err) {
      this.buffer.unshift(...batch);
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[AUDIT CRITICAL] batched flush failed: path=${this.filePath} lines=${batch.length} reason=${reason}`);
    }
  }

  private _ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref();
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
