/**
 * StreamWriter - 追加写 stream.jsonl
 */
import type { FileSystem } from '../fs/types.js';

interface StreamEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

interface StreamRetentionOptions {
  maxFiles?: number | null;
  maxDays?: number | null;
}

/** stream.jsonl 相对路径 */
const STREAM_FILE = 'stream.jsonl';
/** 归档目录相对路径 */
const ARCHIVE_DIR = 'logs/stream';

export class StreamWriter {
  private fs: FileSystem;
  private retention: StreamRetentionOptions;
  private isOpen = false;

  constructor(fs: FileSystem, retention: StreamRetentionOptions = {}) {
    this.fs = fs;
    this.retention = retention;
  }

  /** daemon 启动时调用：归档旧文件 */
  open(): void {
    if (this.isOpen) return;

    let archiveFailed = false;
    if (this.fs.existsSync(STREAM_FILE)) {
      try {
        this.fs.ensureDirSync(ARCHIVE_DIR);
        this.fs.moveSync(STREAM_FILE, `${ARCHIVE_DIR}/stream.${Date.now()}.jsonl`);
      } catch (err) {
        archiveFailed = true;
        console.error('[StreamWriter] Failed to archive stream.jsonl, events will append to existing file:',
          err instanceof Error ? err.message : String(err));
      }
    }
    this.pruneArchives();
    this.isOpen = true;
    if (archiveFailed) {
      this.write({ ts: Date.now(), type: 'session_boundary', reason: 'archive_failed' });
    }
  }

  /** 写一行事件 */
  write(event: StreamEvent): void {
    if (!this.isOpen) {
      console.warn('[StreamWriter] write() called before open(), event dropped');
      return;
    }
    const line = JSON.stringify(event) + '\n';
    try {
      this.fs.appendSync(STREAM_FILE, line);
    } catch (err) {
      console.error('[StreamWriter] write failed:',
        err instanceof Error ? err.message : String(err));
    }
  }

  /** daemon 关闭时调用 */
  close(): void {
    this.isOpen = false;
  }

  private pruneArchives(): void {
    const { maxFiles, maxDays } = this.retention;
    if (!maxFiles && !maxDays) return;
    try {
      if (!this.fs.existsSync(ARCHIVE_DIR)) return;

      const files = this.fs.listSync(ARCHIVE_DIR, { pattern: '^stream\\.\\d+\\.jsonl$' })
        .map(f => ({
          path: f.path,
          ts: parseInt(f.name.split('.')[1], 10),
        }))
        .sort((a, b) => b.ts - a.ts);

      const toDelete = new Set<string>();

      if (maxFiles != null) {
        files.slice(maxFiles).forEach(f => toDelete.add(f.path));
      }
      if (maxDays != null) {
        const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
        files.filter(f => f.ts < cutoff).forEach(f => toDelete.add(f.path));
      }

      for (const p of toDelete) {
        try {
          this.fs.deleteSync(p);
        } catch (err) {
          console.warn('[StreamWriter] failed to delete archive:', p,
            err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      console.warn('[StreamWriter] pruneArchives failed:',
        err instanceof Error ? err.message : String(err));
    }
  }
}
