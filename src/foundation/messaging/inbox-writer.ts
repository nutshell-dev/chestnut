/**
 * Inbox writer - write messages to inbox/pending/
 *
 * Core write operation for the Messaging module.
 * Uses FileSystem for async, atomic writes.
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { FileSystem } from '../fs/types.js';
import type { InboxMessage } from '../../types/contract.js';
import { encodeInbox, parseFrontmatter } from '../message-codec/index.js';
import type { Audit } from '../audit/index.js';
import { ok, err as errResult, type Result } from '../common/result.js';
import type { InboxMetaError } from './errors.js';

export interface InboxMessageOptionsBase {
  type: string;
  source: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  body: string;
  to?: string;
  idPrefix?: string;
  filenameTag?: string;
  extraFields?: Record<string, string>;
}

export class InboxWriter {
  constructor(
    private readonly fs: FileSystem,
    private readonly inboxDir: string,
    private readonly audit: Audit,
  ) {}

  /** async 写，atomic */
  async write(msg: InboxMessage, extraFields?: Record<string, string>): Promise<void> {
    await this.fs.ensureDir(this.inboxDir);
    const timestamp = Date.now();
    const priority = msg.priority ?? 'normal';
    const filename = `${timestamp}_${priority}_${randomUUID().slice(0, 8)}.md`;
    const filePath = path.join(this.inboxDir, filename);
    try {
      await this.fs.writeAtomic(filePath, encodeInbox(msg, extraFields));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.audit.write('inbox_write_failed', `file=${filename}`, `to=${msg.to ?? 'broadcast'}`, `reason=${reason}`);
      throw e;
    }
    this.audit.write('inbox_written', `file=${filename}`, `to=${msg.to ?? 'broadcast'}`);
  }

  /** sync 写，供 task/system 同步路径使用 */
  writeSync(opts: InboxMessageOptionsBase): void {
    const now = new Date();
    const ts = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
    const uuid8 = randomUUID().slice(0, 8);
    const idPrefix = opts.idPrefix ?? opts.type;
    const tag = opts.filenameTag ?? opts.type;

    const message: InboxMessage = {
      id: `${idPrefix}-${now.getTime()}`,
      type: opts.type,
      from: opts.source,
      to: opts.to ?? '',
      content: opts.body,
      priority: opts.priority,
      timestamp: now.toISOString(),
    };

    const content = encodeInbox(message, opts.extraFields);
    this.fs.ensureDirSync(this.inboxDir);
    const filename = `${ts}_${tag}_${uuid8}.md`;
    try {
      this.fs.writeAtomicSync(path.join(this.inboxDir, filename), content);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.audit.write('inbox_write_failed', `file=${filename}`, `to=${opts.to ?? 'broadcast'}`, `reason=${reason}`);
      throw e;
    }
    this.audit.write('inbox_written', `file=${filename}`, `to=${opts.to ?? 'broadcast'}`);
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
      return errResult({ kind: 'read_failed', cause: e });
    }
    try {
      return ok(parseFrontmatter(content).meta);
    } catch (e) {
      return errResult({ kind: 'parse_failed', cause: e });
    }
  }
}

// === Thin wrappers (backward compatible) ===

export interface InboxMessageOptions extends InboxMessageOptionsBase {
  inboxDir: string;
  audit: Audit;
}

/** @deprecated Phase 150 Step 5 过渡：改用 InboxWriter.write */
export async function writeInbox(
  fs: FileSystem,
  inboxDir: string,
  msg: InboxMessage,
  audit: Audit,
  extraFields?: Record<string, string>,
): Promise<void> {
  return new InboxWriter(fs, inboxDir, audit).write(msg, extraFields);
}

/** @deprecated Phase 150 Step 5 过渡：改用 InboxWriter.writeSync */
export function writeInboxMessage(fs: FileSystem, opts: InboxMessageOptions): void {
  const { inboxDir, audit, ...rest } = opts;
  return new InboxWriter(fs, inboxDir, audit).writeSync(rest);
}

/** @deprecated Phase 150 Step 5 过渡：改用 InboxWriter.readMeta */
export function readInboxFileMeta(
  fs: FileSystem,
  filePath: string,
): Result<Record<string, string>, InboxMetaError> {
  return InboxWriter.readMeta(fs, filePath);
}
