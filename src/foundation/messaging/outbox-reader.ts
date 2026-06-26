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
import type { AuditLog } from '../audit/index.js';
import { emitOutboxListFailed, emitOutboxPeekFailed } from './audit-emit.js';
import { decodeOutbox } from './codec-outbox.js';
import type { OutboxMessage } from './types.js';
import {
  OUTBOX_PENDING_DIR,
  OUTBOX_PROCESSING_DIR,
  OUTBOX_DONE_DIR,
} from './dirs.js';
import { newShortUuid } from '../node-utils/index.js';
import { emitOutboxDelivered } from './audit-emit.js';

export class OutboxReader {
  constructor(
    private readonly fs: FileSystem,
    private readonly audit: AuditLog,
  ) {}

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
    const claimToken = `cli_${newShortUuid()}`;
    const relPendingPath = path.join(pendingDir, fileName);
    const relClaimedPath = path.join(processingDir, `${claimToken}_${fileName}`);

    // Atomic claim
    try {
      await this.fs.move(relPendingPath, relClaimedPath);
    } catch (err) {
      if (isFileNotFound(err)) return null; // race lost
      return null;
    }

    // Read
    let content: string;
    try {
      content = await this.fs.read(relClaimedPath);
    } catch (err) {
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
