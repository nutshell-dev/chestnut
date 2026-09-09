/**
 * Inbox writer - write messages to inbox/pending/
 *
 * Core write operation for the Messaging module.
 * Uses FileSystem for async, atomic writes.
 */

import * as path from 'path';
import { formatErr, newUuid } from "../node-utils/index.js";
import type { FileSystem } from '../fs/index.js';
import type { InboxMessage } from '../messaging/types.js';
import { encodeInbox, parseFrontmatter } from './codec-inbox.js';
import type { MessagingAuditSink } from './audit-sink.js';

import {
  emitInboxWriteFailed,
  emitInboxWritten,
  emitInboxBodyOversize,
} from './audit-emit.js';
import { MESSAGING_AUDIT_EVENTS } from './audit-events.js';
import { assertMessageShape } from './invariants.js';
import { sanitizeMessageIdentifier } from './sanitize.js';
import type { MessagingWriterLimits } from './config-schema.js';

type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
import type { InboxMetaError } from './errors.js';
import { isFileNotFound } from '../fs/index.js';

// phase 429 Step A (review medium): inbox message body 硬上限、防 disk DoS / runaway bug
// Derivation: 64 KiB 默认 / 覆盖典型 inbox use case (大多 < 4KB) / LLM-generated 长 review
// feedback 余量。phase 1820：上限数值归 messaging config-schema（配置 owner），
// writer 构造期注入（MessagingWriterLimits），不再读 env、不持默认值。

export type InboxMessageMeta = Record<string, string>;

export interface InboxMessageOptionsBase {
  type: string;
  source: string;
  priority?: 'critical' | 'high' | 'normal' | 'low';
  body: string;
  to?: string;
  idPrefix?: string;
  extraFields?: Record<string, string>;
  // phase 434 Step C (review N11 partial、outbox 对称): writeSync 路径 contract_id
  // 跨源 join，可选；caller 在 contract context 内时 set。
  metadata?: Record<string, string>;
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
    private readonly audit: MessagingAuditSink,
    private readonly limits: MessagingWriterLimits,
  ) {}

  /** Internal factory — only callable within the Messaging module. */
  static __internal_create(fs: FileSystem, inboxDir: InboxPath, audit: MessagingAuditSink, limits: MessagingWriterLimits): InboxWriter {
    return new InboxWriter(fs, inboxDir, audit, limits);
  }

  /** async 写，atomic */
  async write(msg: InboxMessage, extraFields?: Record<string, string>): Promise<void> {
    let filename: string | undefined;
    try {
      // phase 273 Step A: schema invariant (violation emit audit、不 throw、不阻 write、保 IO 错 throw)
      assertMessageShape(msg, this.audit, 'inbox', 'write');

      // Phase 1230: filename identity suffix is an independent storage UUID;
      // caller-owned envelope (especially `id`) must be preserved unchanged.
      const filenameUuid = newUuid();

      // phase 933: wire size limit covers the encoded payload (body + metadata + extraFields)
      const encoded = encodeInbox(msg, extraFields);
      const wireSize = Buffer.byteLength(encoded, 'utf-8');
      const maxBytes = this.limits.bodyMaxBytes;
      if (wireSize > maxBytes) {
        emitInboxBodyOversize(this.audit, {
          source: msg.from,
          to: msg.to,
          type: msg.type,
          bodySize: Buffer.byteLength(msg.content, 'utf-8'),
          wireSize,
          cap: maxBytes,
          contractId: msg.metadata?.contract_id,
        });
        throw new Error(`Inbox wire size ${wireSize} bytes exceeds cap ${maxBytes}`);
      }

      await this.fs.ensureDir(this.inboxDir);
      const timestamp = String(Date.now()).padStart(15, '0');
      const priority = msg.priority ?? 'normal';
      const source = sanitizeMessageIdentifier(msg.from || 'unknown', 'from');
      filename = `${source}-${timestamp}_${priority}_${filenameUuid}.md`;
      const filePath = path.join(this.inboxDir, filename);
      await this.fs.writeAtomic(filePath, encoded);
      emitInboxWritten(this.audit, { file: filename as string, to: msg.to, contractId: msg.metadata?.contract_id });
    } catch (e) {
      const reason = formatErr(e);
      emitInboxWriteFailed(this.audit, { file: filename ?? '<unknown>', to: msg.to, reason, contractId: msg.metadata?.contract_id });
      throw e;
    }
  }

  /**
   * Remove pending messages produced by one source. Messaging owns filename
   * encoding and the pending directory; callers never inspect either detail.
   */
  async removePendingBySource(source: string): Promise<{ removed: number; failed: number }> {
    const safeSource = sanitizeMessageIdentifier(source || 'unknown', 'source');
    const prefix = `${safeSource}-`;
    let entries: { name: string }[];
    try {
      entries = await this.fs.list(this.inboxDir, { includeDirs: false });
    } catch (error) {
      if (isFileNotFound(error)) return { removed: 0, failed: 0 };
      this.audit.write(
        MESSAGING_AUDIT_EVENTS.INBOX_PENDING_SOURCE_CLEANUP_FAILED,
        `source=${safeSource}`,
        'op=list',
        `error=${formatErr(error)}`,
      );
      return { removed: 0, failed: 1 };
    }

    let removed = 0;
    let failed = 0;
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) continue;
      try {
        await this.fs.delete(path.join(this.inboxDir, entry.name));
        removed++;
      } catch (error) {
        failed++;
        this.audit.write(
          MESSAGING_AUDIT_EVENTS.INBOX_PENDING_SOURCE_CLEANUP_FAILED,
          `source=${safeSource}`,
          `file=${entry.name}`,
          'op=delete',
          `error=${formatErr(error)}`,
        );
      }
    }
    return { removed, failed };
  }

  /** sync 写，供 task/system 同步路径使用 */
  writeSync(opts: InboxMessageOptionsBase): string {
    const now = new Date();
    const priority = opts.priority ?? 'normal';
    const timestamp = String(now.getTime()).padStart(15, '0');
    const idPrefix = opts.idPrefix ?? opts.type;

    // Phase 1230: single UUID shared by envelope id and filename suffix.
    const messageUuid = newUuid();
    const message: InboxMessage = {
      id: `${idPrefix}-${messageUuid}`,
      type: opts.type as InboxMessage['type'],
      from: opts.source,
      to: opts.to ?? '',
      content: opts.body,
      priority,
      timestamp: now.toISOString(),
      metadata: opts.metadata,
    };

    // phase 273 Step A:
    assertMessageShape(message, this.audit, 'inbox', 'write');

    // phase 933: wire size limit covers the encoded payload (body + metadata + extraFields)
    const encoded = encodeInbox(message, opts.extraFields);
    const wireSize = Buffer.byteLength(encoded, 'utf-8');
    const maxBytes = this.limits.bodyMaxBytes;
    if (wireSize > maxBytes) {
      emitInboxBodyOversize(this.audit, {
        source: opts.source,
        to: opts.to,
        type: opts.type,
        bodySize: Buffer.byteLength(opts.body, 'utf-8'),
        wireSize,
        cap: maxBytes,
        contractId: opts.metadata?.contract_id,
      });
      throw new Error(`Inbox wire size ${wireSize} bytes exceeds cap ${maxBytes}`);
    }

    let filename: string | undefined;
    try {
      this.fs.ensureDirSync(this.inboxDir);
      const source = sanitizeMessageIdentifier(opts.source || 'unknown', 'source');
      filename = `${source}-${timestamp}_${priority}_${messageUuid}.md`;
      this.fs.writeAtomicSync(path.join(this.inboxDir, filename), encoded);
    } catch (e) {
      const reason = formatErr(e);
      emitInboxWriteFailed(this.audit, { file: filename ?? '<unknown>', to: opts.to, reason, contractId: opts.metadata?.contract_id });
      throw e;
    }
    emitInboxWritten(this.audit, { file: filename as string, to: opts.to, contractId: opts.metadata?.contract_id });
    return filename as string;
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
        return { ok: false as const, error: { kind: 'not_found', cause: e } };
      }
      if ((e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'EPERM') {
        return { ok: false as const, error: { kind: 'permission_denied', cause: e } };
      }
      if ((e as NodeJS.ErrnoException).code === 'EIO' || (e as NodeJS.ErrnoException).code === 'EBUSY' || (e as NodeJS.ErrnoException).code === 'ENOSPC') {
        return { ok: false as const, error: { kind: 'io_failed', cause: e } };
      }
        return { ok: false as const, error: { kind: 'read_failed', cause: e } };
    }
    try {
        return { ok: true as const, value: parseFrontmatter(content).meta };
    } catch (e) {
        return { ok: false as const, error: { kind: 'parse_failed', cause: e } };
    }
  }
}
