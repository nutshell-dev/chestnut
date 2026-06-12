/**
 * Inbox writer - write messages to inbox/pending/
 *
 * Core write operation for the Messaging module.
 * Uses FileSystem for async, atomic writes.
 */

import * as path from 'path';
import { formatErr } from "../utils/index.js";
import type { FileSystem } from '../fs/types.js';
import type { InboxMessage } from '../messaging/types.js';
import { encodeInbox, parseFrontmatter } from './codec-inbox.js';
import type { AuditLog } from '../audit/index.js';

import {
  emitInboxWriteFailed,
  emitInboxWritten,
} from './audit-emit.js';
import { assertMessageShape } from './invariants.js';
import { SequenceCounter, formatSeq } from './sequence-counter.js';
import { ok, err as errResult, type Result } from '../utils/index.js';
import type { InboxMetaError } from './errors.js';
import { isFileNotFound } from '../fs/types.js';

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

function deriveClawDirFromInboxDir(inboxDir: string): string {
  const normalized = path.normalize(inboxDir);
  const parts = normalized.split(path.sep).filter(p => p.length > 0);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    if (
      (secondLast === 'inbox' && (last === 'pending' || last === 'dead-letter')) ||
      (secondLast === 'outbox' && last === 'pending')
    ) {
      return parts.slice(0, -2).join(path.sep) || '.';
    }
  }
  return normalized || '.';
}

export class InboxWriter {
  private readonly counter: SequenceCounter;

  private constructor(
    private readonly fs: FileSystem,
    private readonly inboxDir: InboxPath,
    private readonly audit: AuditLog,
  ) {
    this.counter = new SequenceCounter(fs, deriveClawDirFromInboxDir(inboxDir));
  }

  /** Internal factory — only callable within the Messaging module. */
  static __internal_create(fs: FileSystem, inboxDir: InboxPath, audit: AuditLog): InboxWriter {
    return new InboxWriter(fs, inboxDir, audit);
  }

  /** async 写，atomic */
  async write(msg: InboxMessage, extraFields?: Record<string, string>): Promise<void> {
    // phase 273 Step A: schema invariant (violation emit audit、不 throw、不阻 write、保 IO 错 throw)
    assertMessageShape(msg, this.audit, 'inbox', 'write');

    await this.fs.ensureDir(this.inboxDir);
    const timestamp = String(Date.now()).padStart(15, '0');
    const priority = msg.priority ?? 'normal';
    const source = msg.from || 'unknown';
    const seq = await this.counter.next();
    const filename = `${source}-${timestamp}_${priority}_${formatSeq(seq)}.md`;
    const filePath = path.join(this.inboxDir, filename);
    try {
      await this.fs.writeAtomic(filePath, encodeInbox(msg, extraFields));
    } catch (e) {
      const reason = formatErr(e);
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
    const idPrefix = opts.idPrefix ?? opts.type;

    const message: InboxMessage = {
      id: `${idPrefix}-${now.getTime()}`,
      type: opts.type as InboxMessage['type'],
      from: opts.source,
      to: opts.to ?? '',
      content: opts.body,
      priority,
      timestamp: now.toISOString(),
    };

    // phase 273 Step A:
    assertMessageShape(message, this.audit, 'inbox', 'write');

    this.fs.ensureDirSync(this.inboxDir);
    const source = opts.source || 'unknown';
    const seq = this.counter.nextSync();
    const filename = `${source}-${timestamp}_${priority}_${formatSeq(seq)}.md`;
    try {
      const content = encodeInbox(message, opts.extraFields);
      this.fs.writeAtomicSync(path.join(this.inboxDir, filename), content);
    } catch (e) {
      const reason = formatErr(e);
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
    } catch (e) {
      if (isFileNotFound(e)) {
        return errResult({ kind: 'not_found', cause: e });
      }
      if ((e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'EPERM') {
        return errResult({ kind: 'permission_denied', cause: e });
      }
      if ((e as NodeJS.ErrnoException).code === 'EIO' || (e as NodeJS.ErrnoException).code === 'EBUSY' || (e as NodeJS.ErrnoException).code === 'ENOSPC') {
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


