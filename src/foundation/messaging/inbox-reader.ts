/**
 * InboxReader - Inbox message processor (Messaging L2)
 *
 * Pure message pull and file management. No file-watching.
 * - drainInbox(): read pending, sort by priority, return entries
 * - markDone/markFailed: move files to done/ or failed/
 *
 * File-watching orchestration lives in Runtime (assembly layer).
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { FileSystem } from '../fs/types.js';
import type { InboxMessage } from '../../types/messaging.js';
import { PRIORITY_VALUES, type Priority } from '../../types/priority.js';
import { decodeInbox } from './codec-inbox.js';
import type { AuditLog } from '../audit/index.js';
import { MESSAGING_AUDIT_EVENTS } from './audit-events.js';
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
  constructor(
    private readonly pendingDir: string,
    private readonly doneDir: string,
    private readonly failedDir: string,
    private readonly fs: FileSystem,
    private readonly audit: AuditLog,
  ) {}

  /** Ensure inbox directories exist */
  async init(): Promise<void> {
    await this.fs.ensureDir(this.pendingDir);
    await this.fs.ensureDir(this.doneDir);
    await this.fs.ensureDir(this.failedDir);
  }

  /**
   * Read all pending messages, sorted by priority (desc) then timestamp (asc).
   * Malformed files are automatically moved to failed/ (side effect).
   * Returns valid messages with their file paths for subsequent markDone/markFailed calls.
   */
  async drainInbox(): Promise<InboxEntry[]> {
    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(this.pendingDir, { includeDirs: false });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      // pendingDir 尚未创建属正常首次运行：视为集合空，不抛
      if (code === 'FS_NOT_FOUND' || code === 'ENOENT') return [];
      // 其余 list 失败均为不可预期 I/O / 权限错误，必须冒泡
      const reason = err instanceof Error ? err.message : String(err);
      this.audit.write(
        MESSAGING_AUDIT_EVENTS.INBOX_LIST_FAILED,
        `dir=${this.pendingDir}`,
        `error_code=${classifyErrno(err)}`,
        `reason=${reason}`,
      );
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
        // M4 phase 577：unknown priority audit warn / observability 加固
        // codec-inbox 是 pure fn / decoder 调用方负责 audit
        if (message.extraMeta?.__original_priority !== undefined) {
          this.audit.write(
            MESSAGING_AUDIT_EVENTS.INBOX_PRIORITY_UNKNOWN,
            `file=${entry.name}`,
            `original=${message.extraMeta.__original_priority}`,
            `fallback=${message.priority}`,
          );
        }

        // taskId dedupe: extract from content JSON
        // (all task-result messages carry taskId in content JSON; non-JSON content skips dedupe)
        let taskId: string | undefined;
        try {
          const parsed = JSON.parse(message.content);
          if (typeof parsed.taskId === 'string') {
            taskId = parsed.taskId;
          }
        } catch {
          // silent: non-JSON content (user_chat, heartbeat, etc.) — skip dedupe
        }

        if (taskId && seenTaskIds.has(taskId)) {
          // duplicate: already have a message for this task in this batch
          // silently dedupe + move to done/ (content already represented by first message)
          this.audit.write(
            MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED,
            `file=${entry.name}`,
            `taskId=${taskId}`,
          );
          try {
            await this.markDone(filePath);
          } catch {
            // silent: best-effort markDone fail → next drainInbox re-encounters + re-dedupes
          }
          continue;
        }
        if (taskId) {
          seenTaskIds.add(taskId);
        }

        results.push({ message, filePath });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.audit.write(
          MESSAGING_AUDIT_EVENTS.INBOX_FAILED,
          `file=${entry.name}`,
          `error_code=${classifyErrno(err)}`,
          `reason=${reason}`,
        );
        try {
          await this.markFailed(filePath);
        } catch (moveErr) {
          // markFailed 抛：消息仍停在 pending；本轮跳过、冒泡让上层决策
          throw moveErr;
        }
      }
    }

    results.sort((a, b) => {
      const pa = PRIORITY_VALUES[a.message.priority] ?? PRIORITY_VALUES.normal;
      const pb = PRIORITY_VALUES[b.message.priority] ?? PRIORITY_VALUES.normal;
      if (pa !== pb) return pb - pa; // Higher priority first
      const ta = new Date(a.message.timestamp).getTime() || 0;
      const tb = new Date(b.message.timestamp).getTime() || 0;
      return ta - tb; // Older first (FIFO)
    });

    return results;
  }

  /** Move processed file to done/ */
  async markDone(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const uuid8 = randomUUID().slice(0, UUID_SHORT_LEN);
    const targetPath = path.join(this.doneDir, `${Date.now()}_${uuid8}_${fileName}`);
    try {
      await this.fs.move(filePath, targetPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.audit.write(
        MESSAGING_AUDIT_EVENTS.INBOX_MOVE_FAILED,
        `file=${fileName}`,
        `op=done`,
        `error_code=${classifyErrno(err)}`,
        `reason=${reason}`,
      );
      throw new InboxMoveFailed(filePath, 'done', err);
    }
    this.audit.write(MESSAGING_AUDIT_EVENTS.INBOX_DONE, `file=${fileName}`);
  }

  /**
   * Non-consuming peek of inbox meta entries (no file move, no delete).
   * Used by Runtime to decide step yield without consuming messages.
   *
   * @param filter Optional filter (e.g. by priority)
   * @returns Array of meta entries matching filter (or all if no filter)
   */
  async peekMetas(filter?: { priority?: Priority[] }): Promise<InboxMessageMeta[]> {
    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(this.pendingDir, { includeDirs: false });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'FS_NOT_FOUND' || code === 'ENOENT') return [];
      // 其他 list 失败 audit + 返回空（peek 不冒泡 / 与 drainInbox 不同行为）
      const reason = err instanceof Error ? err.message : String(err);
      this.audit.write(
        MESSAGING_AUDIT_EVENTS.INBOX_LIST_FAILED,
        `dir=${this.pendingDir}`,
        `op=peek`,
        `error_code=${classifyErrno(err)}`,
        `reason=${reason}`,
      );
      return [];
    }

    const results: InboxMessageMeta[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const filePath = path.join(this.pendingDir, entry.name);
      const result = InboxWriter.readMeta(this.fs, filePath);
      if (!result.ok) {
        if (result.error.kind === 'not_found') {
          // race-skip: file 被 markDone/markFailed 并发移走、非真 failure (phase 1011 D.2)
          this.audit.write(MESSAGING_AUDIT_EVENTS.INBOX_PEEK_RACE_SKIP, `file=${entry.name}`);
        } else {
          this.audit.write(MESSAGING_AUDIT_EVENTS.INBOX_META_FAILED, `file=${entry.name}`, `kind=${result.error.kind}`);
        }
        continue;
      }
      const meta = result.value;
      if (filter?.priority && !filter.priority.includes(meta.priority as Priority)) continue;
      results.push(meta);
    }
    return results;
  }

  /** Move failed file to failed/ */
  async markFailed(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const uuid8 = randomUUID().slice(0, UUID_SHORT_LEN);
    const targetPath = path.join(this.failedDir, `${Date.now()}_${uuid8}_${fileName}`);
    try {
      await this.fs.move(filePath, targetPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.audit.write(
        MESSAGING_AUDIT_EVENTS.INBOX_MOVE_FAILED,
        `file=${fileName}`,
        `op=failed`,
        `error_code=${classifyErrno(err)}`,
        `reason=${reason}`,
      );
      throw new InboxMoveFailed(filePath, 'failed', err);
    }
    // markFailed 成功不 audit（归档本身是降级路径，audit 已在解析/处理失败时记）
  }
}
