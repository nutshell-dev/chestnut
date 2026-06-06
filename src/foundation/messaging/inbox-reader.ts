/**
 * InboxReader - Inbox message processor (Messaging L2)
 *
 * Pure message pull and file management. No file-watching.
 * - drainInbox(): read pending, sort by priority, return entries (legacy, no file move)
 * - drainAndDeliver(): read pending, move to inflight/, return entries + handles
 * - ack/nack: confirm or reject delivery of inflight handles
 * - markDone/markFailed: move files to done/ or failed/ (legacy helpers)
 *
 * File-watching orchestration lives in Runtime (assembly layer).
 */

import * as path from 'path';
import { formatErr } from "../utils/index.js";
import { randomUUID } from 'crypto';
import type { FileSystem } from '../fs/types.js';
import type { InboxMessage, InboxHandle } from '../messaging/types.js';
import { PRIORITY_VALUES, type Priority } from '../messaging/types.js';
import { decodeInbox } from './codec-inbox.js';
import type { AuditLog } from '../audit/index.js';
import {
  emitInboxDeduped,
  emitInboxDone,
  emitInboxFailed,
  emitInboxLegacyClawIdField,
  emitInboxListFailed,
  emitInboxMarkDoneFailed,
  emitInboxMetaFailed,
  emitInboxMoveFailed,
  emitInboxNack,
  emitInboxPeekRaceSkip,
  emitInboxPriorityUnknown,
  emitInboxReconcile,
  emitOutboxDelivered,
} from './audit-emit.js';
import { InboxWriter, type InboxMessageMeta } from './inbox-writer.js';
import { UUID_SHORT_LEN } from '../../constants.js';
import { InboxListFailed, InboxMoveFailed } from './errors.js';




function classifyErrno(err: unknown): 'ENOSPC' | 'EACCES' | 'EIO' | 'EMFILE' | 'ENOENT' | 'OTHER' {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC' || code === 'EACCES' || code === 'EIO' || code === 'EMFILE' || code === 'ENOENT') {
      return code;
    }
  }
  return 'OTHER';
}

export interface InboxEntry {
  message: InboxMessage;
  filePath: string;
}

export class InboxReader {
  private readonly inflightDir: string;

  constructor(
    private readonly pendingDir: string,
    private readonly doneDir: string,
    private readonly failedDir: string,
    private readonly fs: FileSystem,
    private readonly audit: AuditLog,
    inflightDir?: string,
  ) {
    // Default inflight dir derived from pending dir: pending/ → inflight/
    this.inflightDir = inflightDir ?? pendingDir.replace(/\/pending\/?$/, '/inflight');
  }

  /** Ensure inbox directories exist + reconcile orphaned inflight files */
  async init(): Promise<void> {
    await this.fs.ensureDir(this.pendingDir);
    await this.fs.ensureDir(this.doneDir);
    await this.fs.ensureDir(this.failedDir);
    await this.fs.ensureDir(this.inflightDir);
    await this._reconcileInflight();
  }

  /**
   * Reconcile orphaned inflight files back to pending on startup.
   * Guarantees DP「中断可恢复」+「未经显式决策不得丢弃」。
   */
  private async _reconcileInflight(): Promise<void> {
    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(this.inflightDir, { includeDirs: false });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'FS_NOT_FOUND' || code === 'ENOENT') return;
      const reason = formatErr(err);
      emitInboxListFailed(this.audit, {
        dir: this.inflightDir,
        op: 'reconcile',
        errorCode: classifyErrno(err),
        reason,
      });
      return;
    }

    let revertedCount = 0;
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const sourcePath = path.join(this.inflightDir, entry.name);
      const targetPath = path.join(this.pendingDir, entry.name);
      try {
        await this.fs.move(sourcePath, targetPath);
        revertedCount++;
      } catch (err) {
        const reason = formatErr(err);
        emitInboxMoveFailed(this.audit, {
          file: entry.name,
          op: 'reconcile_pending',
          errorCode: classifyErrno(err),
          reason,
        });
      }
    }

    if (revertedCount > 0) {
      emitInboxReconcile(this.audit, {
        revertedCount,
        from: 'inflight',
        to: 'pending',
        reason: 'startup_reconcile',
      });
    }
  }

  /**
   * Read all pending messages, sort by priority (desc) then timestamp (asc).
   * Malformed files are automatically moved to failed/ (side effect).
   * Files remain in pending/ — this is a non-consuming read.
   * Legacy path; Runtime should prefer drainAndDeliver().
   */
  async drainInbox(): Promise<InboxEntry[]> {
    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(this.pendingDir, { includeDirs: false });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'FS_NOT_FOUND' || code === 'ENOENT') return [];
      const reason = formatErr(err);
      emitInboxListFailed(this.audit, {
        dir: this.pendingDir,
        errorCode: classifyErrno(err),
        reason,
      });
      throw new InboxListFailed(this.pendingDir, err);
    }

    const results: InboxEntry[] = [];
    const seenTaskIds = new Set<string>();
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const filePath = path.join(this.pendingDir, entry.name);
      try {
        const content = await this.fs.read(filePath);
        const message = decodeInbox(content);
        if (message.extraMeta?.__original_priority !== undefined) {
          emitInboxPriorityUnknown(this.audit, {
            file: entry.name,
            original: message.extraMeta.__original_priority,
            fallback: message.priority,
          });
        }
        if (message.extraMeta?.__legacy_claw_id !== undefined) {
          emitInboxLegacyClawIdField(this.audit, {
            file: entry.name,
            clawId: message.extraMeta.__legacy_claw_id,
          });
        }

        let taskId: string | undefined;
        try {
          const parsed = JSON.parse(message.content);
          if (typeof parsed.taskId === 'string') {
            taskId = parsed.taskId;
          }
        } catch {
          // silent: non-JSON content — skip dedupe
        }

        if (taskId && seenTaskIds.has(taskId)) {
          emitInboxDeduped(this.audit, { file: entry.name, taskId });
          try {
            await this.markDone(filePath);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
              emitInboxMarkDoneFailed(this.audit, { reason: (e as Error).message });
            }
          }
          continue;
        }
        if (taskId) {
          seenTaskIds.add(taskId);
        }

        results.push({ message, filePath });
      } catch (err) {
        const reason = formatErr(err);
        emitInboxFailed(this.audit, {
          file: entry.name,
          errorCode: classifyErrno(err),
          reason,
        });
        try {
          await this.markFailed(filePath);
        } catch (moveErr) {
          throw moveErr;
        }
      }
    }

    results.sort((a, b) => {
      const pa = PRIORITY_VALUES[a.message.priority] ?? PRIORITY_VALUES.normal;
      const pb = PRIORITY_VALUES[b.message.priority] ?? PRIORITY_VALUES.normal;
      if (pa !== pb) return pb - pa;
      const ta = new Date(a.message.timestamp).getTime() || 0;
      const tb = new Date(b.message.timestamp).getTime() || 0;
      return ta - tb;
    });

    return results;
  }

  /**
   * Drain pending messages and move them to inflight/ (delivered but not yet acked).
   * Returns both decoded entries and handles for subsequent ack/nack.
   * Crash before ack → init() reconcile moves inflight/ back to pending/.
   */
  async drainAndDeliver(): Promise<{ entries: InboxEntry[]; handles: InboxHandle[] }> {
    const entries = await this.drainInbox();
    const handles: InboxHandle[] = [];
    const deliveredEntries: InboxEntry[] = [];

    for (const entry of entries) {
      const fileName = path.basename(entry.filePath);
      const inflightPath = path.join(this.inflightDir, fileName);
      try {
        await this.fs.move(entry.filePath, inflightPath);
        const now = new Date();
        await this.fs.utimes(inflightPath, now, now);
        handles.push({ filePath: inflightPath, originalFileName: fileName });
        deliveredEntries.push({ message: entry.message, filePath: inflightPath });
      } catch (err) {
        const reason = formatErr(err);
        emitInboxMoveFailed(this.audit, {
          file: fileName,
          op: 'deliver_inflight',
          errorCode: classifyErrno(err),
          reason,
        });
        // Stop delivering at first move failure; remaining stay in pending/
        break;
      }
    }

    return { entries: deliveredEntries, handles };
  }

  /** Acknowledge handle: move from inflight/ to done/ */
  async ack(handle: InboxHandle): Promise<void> {
    const fileName = handle.originalFileName;
    const uuid8 = randomUUID().slice(0, UUID_SHORT_LEN);
    const targetPath = path.join(this.doneDir, `${Date.now()}_${uuid8}_${fileName}`);
    try {
      await this.fs.move(handle.filePath, targetPath);
    } catch (err) {
      const reason = formatErr(err);
      emitInboxMoveFailed(this.audit, {
        file: fileName,
        op: 'ack_done',
        errorCode: classifyErrno(err),
        reason,
      });
      throw new InboxMoveFailed(handle.filePath, 'ack_done', err);
    }
    emitInboxDone(this.audit, { file: fileName });
    emitOutboxDelivered(this.audit, { file: fileName });
  }

  /** Negative acknowledge: move from inflight/ back to pending/ */
  async nack(handle: InboxHandle, reason?: string): Promise<void> {
    const fileName = handle.originalFileName;
    const targetPath = path.join(this.pendingDir, fileName);
    try {
      await this.fs.move(handle.filePath, targetPath);
    } catch (err) {
      const errReason = formatErr(err);
      emitInboxMoveFailed(this.audit, {
        file: fileName,
        op: 'nack_pending',
        errorCode: classifyErrno(err),
        reason: errReason,
      });
      throw new InboxMoveFailed(handle.filePath, 'nack_pending', err);
    }
    emitInboxNack(this.audit, { file: fileName, reason });
  }

  /** Move processed file to done/ (legacy helper; ack() preferred) */
  async markDone(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const uuid8 = randomUUID().slice(0, UUID_SHORT_LEN);
    const targetPath = path.join(this.doneDir, `${Date.now()}_${uuid8}_${fileName}`);
    try {
      await this.fs.move(filePath, targetPath);
    } catch (err) {
      const reason = formatErr(err);
      emitInboxMoveFailed(this.audit, {
        file: fileName,
        op: 'done',
        errorCode: classifyErrno(err),
        reason,
      });
      throw new InboxMoveFailed(filePath, 'done', err);
    }
    emitInboxDone(this.audit, { file: fileName });
    emitOutboxDelivered(this.audit, { file: fileName });
  }

  /**
   * Non-consuming peek of inbox meta entries (no file move, no delete).
   */
  async peekMetas(filter?: { priority?: Priority[] }): Promise<InboxMessageMeta[]> {
    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(this.pendingDir, { includeDirs: false });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'FS_NOT_FOUND' || code === 'ENOENT') return [];
      const reason = formatErr(err);
      emitInboxListFailed(this.audit, {
        dir: this.pendingDir,
        op: 'peek',
        errorCode: classifyErrno(err),
        reason,
      });
      return [];
    }

    const results: InboxMessageMeta[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const filePath = path.join(this.pendingDir, entry.name);
      const result = InboxWriter.readMeta(this.fs, filePath);
      if (!result.ok) {
        if (result.error.kind === 'not_found') {
          emitInboxPeekRaceSkip(this.audit, { file: entry.name });
        } else {
          emitInboxMetaFailed(this.audit, { file: entry.name, kind: result.error.kind });
        }
        continue;
      }
      const meta = result.value;
      if (filter?.priority && !filter.priority.includes(meta.priority as Priority)) continue;
      results.push(meta);
    }
    return results;
  }

  /**
   * Find first inbox message whose extraMeta[key] === value.
   *
   * Scope:
   * - pending/ (any age)
   * - done/ (mtime within opts.includeDoneWithinMs)
   *
   * Returns first hit (no need to enumerate all).
   *
   * Use case: dedup query — caller wants to check "is there already a delivered/pending
   * message with this hash within 24h?" before writing a new one.
   *
   * Performance: parses every candidate file's meta (no index). For high-frequency
   * queries, caller should cache result or this method should grow a hash index sidecar.
   *
   * @param key extraMeta key (e.g., 'summary-hash')
   * @param value extraMeta value to match (string)
   * @param opts.includeDoneWithinMs done file mtime window (ms); 0 / undefined → pending only
   * @returns null if no hit, else { file: <basename>, location: 'pending' | 'done' }
   */
  async findByExtraMeta(
    key: string,
    value: string,
    opts: { includeDoneWithinMs?: number } = {},
  ): Promise<{ file: string; location: 'pending' | 'done' } | null> {
    const pendingHit = await this._scanByExtraMeta(this.pendingDir, key, value, undefined);
    if (pendingHit) return { file: pendingHit, location: 'pending' };

    const windowMs = opts.includeDoneWithinMs ?? 0;
    if (windowMs > 0) {
      const cutoff = Date.now() - windowMs;
      const doneHit = await this._scanByExtraMeta(this.doneDir, key, value, cutoff);
      if (doneHit) return { file: doneHit, location: 'done' };
    }

    return null;
  }

  private async _scanByExtraMeta(
    dir: string,
    key: string,
    value: string,
    mtimeCutoff: number | undefined,
  ): Promise<string | null> {
    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(dir, { includeDirs: false });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'FS_NOT_FOUND' || code === 'ENOENT') return null;
      return null;
    }

    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const filePath = path.join(dir, entry.name);

      if (mtimeCutoff !== undefined) {
        try {
          const s = await this.fs.stat(filePath);
          if (s.mtime.getTime() < mtimeCutoff) continue;
        } catch {
          continue;
        }
      }

      const result = InboxWriter.readMeta(this.fs, filePath);
      if (!result.ok) continue;
      const meta = result.value;
      if (meta[key] === value) return entry.name;
    }
    return null;
  }

  /** Move failed file to failed/ (legacy helper) */
  async markFailed(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const uuid8 = randomUUID().slice(0, UUID_SHORT_LEN);
    const targetPath = path.join(this.failedDir, `${Date.now()}_${uuid8}_${fileName}`);
    try {
      await this.fs.move(filePath, targetPath);
    } catch (err) {
      const reason = formatErr(err);
      emitInboxMoveFailed(this.audit, {
        file: fileName,
        op: 'failed',
        errorCode: classifyErrno(err),
        reason,
      });
      throw new InboxMoveFailed(filePath, 'failed', err);
    }
  }
}
