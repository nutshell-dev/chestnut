/**
 * StreamWriter - 追加写 stream.jsonl
 */
import type { FileSystem } from '../fs/types.js';
import { STREAM_FILE, type StreamEvent, type StreamLog } from './types.js';
import type { AuditLog } from '../audit/index.js';
import { STREAM_AUDIT_EVENTS } from './audit-events.js';
import { randomUUID } from 'node:crypto';

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

  /** lifecycle init: archives old files (caller-managed) */
  open(): void {
    if (this.isOpen) return;

    let archiveFailed = false;
    if (this.fs.existsSync(STREAM_FILE)) {
      try {
        // Phase 1105: truncation recovery before archive — ensure last line is complete
        const nodeFs = this.fs as unknown as { readSync(path: string): string; writeAtomicSync(path: string, content: string): void };
        try {
          const content = nodeFs.readSync(STREAM_FILE);
          const lastNewline = content.lastIndexOf('\n');
          if (lastNewline !== -1 && lastNewline < content.length - 1) {
            nodeFs.writeAtomicSync(STREAM_FILE, content.substring(0, lastNewline + 1));
          }
        } catch (err) {
          this.audit.write(
            STREAM_AUDIT_EVENTS.TRUNCATION_REPAIR_FAILED,
            `reason=${err instanceof Error ? err.message : String(err)}`,
            'archive_will_proceed=true',
          );
        }
        this.fs.ensureDirSync(ARCHIVE_DIR);
        this.fs.moveSync(STREAM_FILE, `${ARCHIVE_DIR}/stream.${Date.now()}_${randomUUID().slice(0, 8)}.jsonl`);
      } catch (err) {
        archiveFailed = true;
        this.audit.write(
          STREAM_AUDIT_EVENTS.ARCHIVE_FAILED,
          `reason=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // === Session boundary invariant (phase 1011 D.4 reframe-⚓ + phase 743 step B):
    //     archive moveSync → STREAM_FILE writeAtomicSync('') 是 documented 序列。
    //     reader-side chokidar 监 STREAM_FILE：
    //       - moveSync 触 'unlink' event
    //       - writeAtomicSync 触 'add' event
    //     reader 端期望 debounce 或忽略 unlink-then-add 短窗（~µs）以避 parse_failed。
    //     既有 WRITER_OPEN_CREATED_EMPTY (line 54) + ARCHIVE_FAILED (line 38) 双 emit 已 cover
    //     session boundary observability；0 NEW emit 必要。
    //     reader 端 stream_reader_unlinked + stream_reader_file_missing 已 cover unlink case。
    //     ⚓ accepted-stable per `feedback_yagni_helper_threshold` (既有 emit cover)。
    // === Race-safe session boundary file initialization (phase 1120 θ fix):
    //     writeFileSync(STREAM_FILE, '', { flag: 'wx' }) = O_CREAT | O_EXCL（OS 原子）
    //     替原 check-then-act（existsSync → writeAtomicSync）的 µs 级 race 窗口：
    //       - 不存在 → 创建空文件 + emit WRITER_OPEN_CREATED_EMPTY
    //       - 已存在（CLI cross-process append race won）→ EEXIST 抛、catch 保留 raced content
    //         + emit WRITER_OPEN_PRESERVED_RACED（observability、forensics 可重建 race）
    //     合规 DP「不丢弃静默」（user Q2 拍板 2026-05-23：不允许条件性接受形态、必本 phase 治）。
    try {
      this.fs.writeExclusiveSync(STREAM_FILE, '');
      this.audit.write(
        STREAM_AUDIT_EVENTS.WRITER_OPEN_CREATED_EMPTY,
        `path=${STREAM_FILE}`,
        'reason=ensure_reader_watcher_compat',
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // CLI cross-process append won the race — preserve raced content as start of new session
        const racedContent = this.fs.readSync(STREAM_FILE);
        this.audit.write(
          STREAM_AUDIT_EVENTS.WRITER_OPEN_PRESERVED_RACED,
          `path=${STREAM_FILE}`,
          `bytes=${racedContent.length}`,
          'reason=cli_cross_process_append_race_won',
        );
      } else {
        throw err;
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
      // cancel / disassemble 期间异步 cleanup 调 write 是预期 race
      // DP「中断可恢复」+ ML#10 不合理停下 → graceful drop + audit
      this.audit.write(
        STREAM_AUDIT_EVENTS.WRITE_AFTER_CLOSE,
        `type=${event.type}`,
        `reason=writer_closed`,
      );
      return;
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

  /** lifecycle dispose (caller-managed) */
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
