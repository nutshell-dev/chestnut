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
import { formatErr } from '../utils/index.js';
import type { FileSystem } from '../fs/types.js';
import { isFileNotFound } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { emitOutboxListFailed, emitOutboxPeekFailed } from './audit-emit.js';
import { decodeOutbox } from './codec-outbox.js';
import type { OutboxMessage } from './types.js';

const OUTBOX_PENDING_SUBDIR = 'outbox/pending';

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
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_SUBDIR);
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
   * Read the **latest** message from `<clawDir>/outbox/pending` (last by filename sort order).
   *
   * Outbox filenames follow `{timestamp}_{type}_{uuid}.md` — lexical sort == time sort asc,
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
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_SUBDIR);
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
