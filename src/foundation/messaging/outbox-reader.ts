/**
 * OutboxReader - 单 claw outbox 读侧 + 列举
 *
 * 业主：Messaging 模块拥 outbox 资源（per architecture.md 表 1）。
 * 外部模块（如 outbox-summary）需要 outbox 状态查询时通过本 class、不直接 fs.list。
 *
 * 当前 scope：只列 pending（outbox 未消费消息）。done/failed/inflight 暂不暴露读接口、
 * caller 按需扩展。
 *
 * phase 42 NEW（前置：outbox-summary 重构、消除 MLP-3 违反）。
 */

import * as path from 'path';
import { formatErr } from '../node-utils/index.js';
import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';
import { isAlive } from '../process-exec/index.js';
import type { AuditLog } from '../audit/index.js';
import { emitOutboxClaimFailed, emitOutboxListFailed, emitOutboxPeekFailed, emitOutboxProcessingOrphanCleaned } from './audit-emit.js';
import { decodeOutbox } from './codec-outbox.js';
import type { OutboxMessage } from './types.js';
import {
  OUTBOX_PENDING_DIR,
  OUTBOX_PROCESSING_DIR,
  OUTBOX_DONE_DIR,
  OUTBOX_FAILED_DIR,
} from './dirs.js';
import { newShortUuid } from '../node-utils/index.js';
import { emitOutboxDelivered } from './audit-emit.js';

export class OutboxReader {
  constructor(
    private readonly fs: FileSystem,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Ensure outbox directories exist + reconcile orphaned processing files back to pending.
   */
  async init(clawDir: string): Promise<void> {
    await this.fs.ensureDir(path.join(clawDir, OUTBOX_PENDING_DIR));
    await this.fs.ensureDir(path.join(clawDir, OUTBOX_PROCESSING_DIR));
    await this.fs.ensureDir(path.join(clawDir, OUTBOX_DONE_DIR));
    await this._reconcileProcessing(clawDir);
  }

  /**
   * Reconcile orphaned processing files back to pending on startup.
   * Guarantees crash recovery: a claimed message that was not marked done/failed
   * will eventually be re-delivered.
   */
  private async _reconcileProcessing(clawDir: string): Promise<void> {
    const processingDir = path.join(clawDir, OUTBOX_PROCESSING_DIR);
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    const doneDir = path.join(clawDir, OUTBOX_DONE_DIR);

    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(processingDir, { includeDirs: false });
    } catch (err) {
      if (isFileNotFound(err)) return;
      emitOutboxListFailed(this.audit, {
        dir: processingDir,
        reason: formatErr(err),
      });
      return;
    }

    let pendingEntries: { name: string }[] = [];
    try {
      pendingEntries = await this.fs.list(pendingDir, { includeDirs: false });
    } catch (err) {
      emitOutboxListFailed(this.audit, {
        dir: pendingDir,
        op: 'reconcile',
        reason: formatErr(err),
      });
      return;
    }

    let revertedCount = 0;
    const pendingSet = new Set(pendingEntries.map(e => e.name));

    const CLAIM_TOKEN_RE = /^cli_(\d+)_[^_]+_(.+\.md)$/;
    const STALE_THRESHOLD_MS = 5 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;

      let originalName: string;
      let shouldReclaim = false;
      const match = entry.name.match(CLAIM_TOKEN_RE);
      if (!match) {
        // Legacy format (pre-Phase 908): no PID, use mtime-based heuristic.
        originalName = entry.name.replace(/^cli_[^_]+_/, '');
        const sourcePath = path.join(processingDir, entry.name);
        let mtime: number;
        try {
          const stat = await this.fs.stat(sourcePath);
          mtime = stat.mtime.getTime();
        } catch (err) {
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_stat',
            reason: formatErr(err),
          });
          continue;
        }
        if (Date.now() - mtime >= STALE_THRESHOLD_MS) {
          shouldReclaim = true;
        }
      } else {
        const pid = parseInt(match[1], 10);
        originalName = match[2];
        if (!isAlive(pid)) {
          shouldReclaim = true;
        }
      }

      if (!shouldReclaim) continue;

      const sourcePath = path.join(processingDir, entry.name);
      const targetPath = path.join(pendingDir, originalName);

      if (pendingSet.has(originalName)) {
        // Duplicate: compare content to decide.
        let sourceContent: string;
        try {
          sourceContent = await this.fs.read(sourcePath);
        } catch (err) {
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_compare_read',
            reason: formatErr(err),
          });
          continue;
        }
        let targetContent: string;
        try {
          targetContent = await this.fs.read(targetPath);
        } catch (err) {
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_compare_read',
            reason: formatErr(err),
          });
          continue;
        }
        if (sourceContent === targetContent) {
          // Same content → already re-delivered by another consumer; archive processing file.
          try {
            await this.fs.move(sourcePath, path.join(doneDir, entry.name));
          } catch (err) {
            emitOutboxClaimFailed(this.audit, {
              file: entry.name,
              op: 'reconcile_archive',
              reason: formatErr(err),
            });
          }
        } else {
          // Different content → conflict, move to DLQ.
          const failedDir = path.join(clawDir, OUTBOX_FAILED_DIR);
          try {
            await this.fs.ensureDir(failedDir);
            await this.fs.move(sourcePath, path.join(failedDir, entry.name));
          } catch (err) {
            emitOutboxClaimFailed(this.audit, {
              file: entry.name,
              op: 'reconcile_dlq',
              reason: formatErr(err),
            });
          }
        }
        continue;
      }

      try {
        await this.fs.move(sourcePath, targetPath);
        revertedCount++;
      } catch (err) {
        const reason = formatErr(err);
        emitOutboxClaimFailed(this.audit, {
          file: entry.name,
          op: 'reconcile_pending',
          reason,
        });
      }
    }

    if (revertedCount > 0) {
      emitOutboxProcessingOrphanCleaned(this.audit, { count: revertedCount });
    }
  }

  /**
   * List `.md` filenames in `<clawDir>/outbox/pending`.
   *
   * Use case: aggregator queries (outbox-summary unread count) 不该自己 fs.list outbox。
   *
   * @param clawDir absolute path to a claw root (per string convention)
   * @returns sorted filename array (basename, not absolute path)
   *   - empty array if dir missing / list failed (silent)
   */
  async listClawOutboxPending(clawDir: string): Promise<string[]> {
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    try {
      const entries = await this.fs.list(pendingDir, { includeDirs: false });
      return entries
        .filter(e => e.name.endsWith('.md'))
        .map(e => e.name)
        .sort();
    } catch (err) {
      if (isFileNotFound(err)) return [];
      emitOutboxListFailed(this.audit, {
        dir: pendingDir,
        reason: formatErr(err),
      });
      return [];
    }
  }

  /**
   * Atomically claim the next pending outbox message.
   *
   * Steps:
   *   1. List pending/, take first .md file (filename-sorted)
   *   2. Move pending/<filename> → processing/<claimToken>_<filename> (atomic claim)
   *   3. Read content from claimed path
   *   4. Return { claimPath, filename, content }
   *
   * Returns null if pending empty, race lost (file disappeared before move), or IO error.
   *
   * The returned `claimPath` is relative to clawDir; caller passes it to markDone()/markFailed().
   *
   * @param clawDir absolute path to a claw root
   * @returns null if nothing to claim, else the claimed message
   */
  async claimNext(clawDir: string): Promise<{
    claimPath: string;
    filename: string;
    content: string;
  } | null> {
    const filenames = await this.listClawOutboxPending(clawDir);
    if (filenames.length === 0) return null;

    const fileName = filenames[0]; // oldest first
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    const processingDir = path.join(clawDir, OUTBOX_PROCESSING_DIR);
    const claimToken = `cli_${process.pid}_${newShortUuid()}`;
    const relPendingPath = path.join(pendingDir, fileName);
    const relClaimedPath = path.join(processingDir, `${claimToken}_${fileName}`);

    // Atomic claim
    try {
      await this.fs.move(relPendingPath, relClaimedPath);
    } catch (err) {
      if (isFileNotFound(err)) return null; // race lost
      // Non-ENOENT: audit the I/O error and return null
      emitOutboxClaimFailed(this.audit, {
        file: fileName,
        op: 'move',
        reason: formatErr(err),
      });
      return null;
    }

    // Read
    let content: string;
    try {
      content = await this.fs.read(relClaimedPath);
    } catch (err) {
      // Rollback: move back to pending so message is not stuck in processing
      try {
        await this.fs.move(relClaimedPath, relPendingPath);
      } catch (rollbackErr) {
        // Rollback failed: leave audit trail, message will be recovered by reconcile on next restart
        emitOutboxClaimFailed(this.audit, {
          file: fileName,
          op: 'read_rollback',
          reason: formatErr(rollbackErr),
        });
      }
      emitOutboxClaimFailed(this.audit, {
        file: fileName,
        op: 'read',
        reason: formatErr(err),
      });
      return null;
    }

    // Build claimPath relative to clawDir (for markDone/markFailed to use)
    const claimPath = path.join(OUTBOX_PROCESSING_DIR, `${claimToken}_${fileName}`);

    return { claimPath, filename: fileName, content };
  }

  /**
   * Mark a claimed outbox message as done — move processing/ → done/.
   *
   * @param clawDir absolute path to a claw root
   * @param claimPath relative path within clawDir (returned by claimNext)
   * @param originalFilename original pending filename (for audit trail)
   */
  async markDone(clawDir: string, claimPath: string, originalFilename: string): Promise<void> {
    const processingFullPath = path.join(clawDir, claimPath);
    const doneDir = path.join(clawDir, OUTBOX_DONE_DIR);
    await this.fs.ensureDir(doneDir);
    const donePath = path.join(doneDir, `${Date.now()}_${originalFilename}`);
    await this.fs.move(processingFullPath, donePath);
    emitOutboxDelivered(this.audit, {
      file: originalFilename,
      deliveredAt: Date.now(),
    } as any);
  }

  /**
   * Read the **latest** message from `<clawDir>/outbox/pending` (last by filename sort order).
   *
   * Outbox filenames follow `{timestamp}_{type}_{seq}.md` — lexical sort == time sort asc,
   * so the last element is the newest.
   *
   * Pure read: no file move/delete side effect.
   *
   * Use case: outbox-summary motion notification — show preview of each claw's latest
   * unread message.
   *
   * Failure modes (all silent → return null + audit):
   *  - pending dir missing → null
   *  - list failure (perms/IO) → null + audit
   *  - read failure (race with consumer) → null + audit
   *  - decode failure (malformed) → null + audit
   *
   * @param clawDir absolute path to a claw root
   * @returns null if pending empty / any failure, else { filename, message }
   */
  async peekLastOutboxPending(
    clawDir: string,
  ): Promise<{ filename: string; message: OutboxMessage } | null> {
    const filenames = await this.listClawOutboxPending(clawDir);
    if (filenames.length === 0) return null;
    const latest = filenames[filenames.length - 1];
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    const filePath = path.join(pendingDir, latest);
    let raw: string;
    try {
      raw = await this.fs.read(filePath);
    } catch (err) {
      emitOutboxPeekFailed(this.audit, {
        file: filePath,
        stage: 'read',
        reason: formatErr(err),
      });
      return null;
    }
    let message: OutboxMessage;
    try {
      message = decodeOutbox(raw);
    } catch (err) {
      emitOutboxPeekFailed(this.audit, {
        file: filePath,
        stage: 'decode',
        reason: formatErr(err),
      });
      return null;
    }
    return { filename: latest, message };
  }
}
