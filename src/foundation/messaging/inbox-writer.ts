/**
 * Inbox writer - write messages to inbox/pending/
 *
 * Core write operation for the Messaging module.
 * Uses FileSystem for async, atomic writes.
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { FileSystem } from '../fs/types.js';
import type { InboxMessage } from '../messaging/types.js';
import { encodeInbox, parseFrontmatter } from './codec-inbox.js';
import type { AuditLog } from '../audit/index.js';

import {
  emitInboxWriteFailed,
  emitInboxWritten,
} from './audit-emit.js';
import { UUID_SHORT_LEN } from '../../constants.js';
import { ok, err as errResult, type Result } from '../utils/result.js';
import type { InboxMetaError } from './errors.js';

export type InboxMessageMeta = Record<string, string>;

export interface InboxMessageOptionsBase {
  type: string;
  source: string;
  priority?: 'critical' | 'high' | 'normal' | 'low';
  body: string;
  to?: string;
  idPrefix?: string;
  extraFields?: Record<string, string>;
}

/** Branded inbox directory path — only makeInboxPath() can construct. */
declare const InboxPathBrand: unique symbol;
export type InboxPath = string & { readonly [InboxPathBrand]: true };

/** Factory: construct an InboxPath from an absolute directory string. */
export function makeInboxPath(absoluteDir: string): InboxPath {
  return absoluteDir as InboxPath;
}

export class InboxWriter {
  private constructor(
    private readonly fs: FileSystem,
    private readonly inboxDir: InboxPath,
    private readonly audit: AuditLog,
  ) {}

  /** Internal factory — only callable within the Messaging module. */
  static __internal_create(fs: FileSystem, inboxDir: InboxPath, audit: AuditLog): InboxWriter {
    return new InboxWriter(fs, inboxDir, audit);
  }

  /** async 写，atomic */
  async write(msg: InboxMessage, extraFields?: Record<string, string>): Promise<void> {
    await this.fs.ensureDir(this.inboxDir);
    const timestamp = String(Date.now()).padStart(15, '0');
    const priority = msg.priority ?? 'normal';
    const source = msg.from || 'unknown';
    const filename = `${source}-${timestamp}_${priority}_${randomUUID().slice(0, UUID_SHORT_LEN)}.md`;
    const filePath = path.join(this.inboxDir, filename);
    try {
      await this.fs.writeAtomic(filePath, encodeInbox(msg, extraFields));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      emitInboxWriteFailed(this.audit, { file: filename, to: msg.to, reason });
      throw e;
    }
    emitInboxWritten(this.audit, { file: filename, to: msg.to });
  }

  /** sync 写，供 task/system 同步路径使用 */
  writeSync(opts: InboxMessageOptionsBase): void {
    const now = new Date();
    const priority = opts.priority ?? 'normal';
    const timestamp = String(now.getTime()).padStart(15, '0');
    const uuid8 = randomUUID().slice(0, UUID_SHORT_LEN);
    const idPrefix = opts.idPrefix ?? opts.type;

    const message: InboxMessage = {
      id: `${idPrefix}-${now.getTime()}`,
      type: opts.type,
      from: opts.source,
      to: opts.to ?? '',
      content: opts.body,
      priority,
      timestamp: now.toISOString(),
    };

    this.fs.ensureDirSync(this.inboxDir);
    const source = opts.source || 'unknown';
    const filename = `${source}-${timestamp}_${priority}_${uuid8}.md`;
    try {
      const content = encodeInbox(message, opts.extraFields);
      this.fs.writeAtomicSync(path.join(this.inboxDir, filename), content);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      emitInboxWriteFailed(this.audit, { file: filename, to: opts.to, reason });
      throw e;
    }
    emitInboxWritten(this.audit, { file: filename, to: opts.to });
  }

  /** 读 frontmatter meta；纯读，静态方法不依赖 audit */
  static readMeta(
    fs: FileSystem,
    filePath: string,
  ): Result<Record<string, string>, InboxMetaError> {
    let content: string;
    try {
      content = fs.readSync(filePath);
    } catch (e: any) {
      if (e?.code === 'FS_NOT_FOUND' || e?.code === 'ENOENT') {
        return errResult({ kind: 'not_found', cause: e });
      }
      if (e?.code === 'EACCES' || e?.code === 'EPERM') {
        return errResult({ kind: 'permission_denied', cause: e });
      }
      if (e?.code === 'EIO' || e?.code === 'EBUSY' || e?.code === 'ENOSPC') {
        return errResult({ kind: 'io_failed', cause: e });
      }
      return errResult({ kind: 'read_failed', cause: e });
    }
    try {
      return ok(parseFrontmatter(content).meta);
    } catch (e) {
      return errResult({ kind: 'parse_failed', cause: e });
    }
  }
}


