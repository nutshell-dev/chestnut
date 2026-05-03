/**
 * StreamWriter - 追加写 stream.jsonl
 */
import type { FileSystem } from '../fs/types.js';
import { STREAM_FILE, type StreamEvent, type StreamLog } from './types.js';
import type { AuditLog } from '../audit/index.js';
import { STREAM_AUDIT_EVENTS } from './audit-events.js';

export interface StreamRetentionOptions {
  maxFiles?: number | null;
  maxDays?: number | null;
}

/** 归档目录相对路径 */
const ARCHIVE_DIR = 'logs/stream';

export class StreamWriter implements StreamLog {
  private fs: FileSystem;
  private audit: AuditLog;
  private retention: StreamRetentionOptions;
  private isOpen = false;

  constructor(fs: FileSystem, audit: AuditLog, retention: StreamRetentionOptions = {}) {
    this.fs = fs;
    this.audit = audit;
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
        this.audit.write(
          STREAM_AUDIT_EVENTS.ARCHIVE_FAILED,
          `reason=${err instanceof Error ? err.message : String(err)}`,
        );
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
      throw new Error('StreamWriter: write() called before open()');
    }
    const line = JSON.stringify(event) + '\n';
    try {
      this.fs.appendSync(STREAM_FILE, line);
    } catch (err) {
      this.audit.write(
        STREAM_AUDIT_EVENTS.APPEND_FAILED,
        `type=${event.type}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
        `body=${line.trimEnd()}`,
      );
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
          this.audit.write(
            STREAM_AUDIT_EVENTS.ARCHIVE_PRUNE_FAILED,
            `path=${p}`,
            `reason=${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.audit.write(
        STREAM_AUDIT_EVENTS.ARCHIVE_PRUNE_FAILED,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
