/**
 * Inbox writer - write messages to inbox/pending/
 *
 * Core write operation for the Messaging module.
 * Uses FileSystem for async, atomic writes.
 */

import * as path from 'path';
import { formatErr, newShortUuid, newUuid } from "../node-utils/index.js";
import type { FileSystem } from '../fs/index.js';
import type { InboxMessage } from '../messaging/types.js';
import { encodeInbox, parseFrontmatter } from './codec-inbox.js';
import type { AuditLog } from '../audit/index.js';

import {
  emitInboxWriteFailed,
  emitInboxWritten,
  emitInboxBodyOversize,
} from './audit-emit.js';
import { assertMessageShape } from './invariants.js';
import { sanitizeMessageIdentifier } from './sanitize.js';
import { getSharedSequenceCounter, formatSeq } from './sequence-counter.js';
import type { SequenceCounter } from './sequence-counter.js';
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
import type { InboxMetaError } from './errors.js';
import { isFileNotFound } from '../fs/index.js';

// phase 429 Step A (review medium): inbox message body 硬上限、防 disk DoS / runaway bug
// Derivation: 64 KiB = 65536 byte / 覆盖典型 inbox use case (大多 < 4KB) / LLM-generated
// 长 review feedback 余量 / env CHESTNUT_INBOX_BODY_MAX_BYTES 覆盖.
const INBOX_BODY_MAX_BYTES_DEFAULT = 64 * 1024;
function getInboxBodyMaxBytes(): number {
  const raw = process.env.CHESTNUT_INBOX_BODY_MAX_BYTES;
  if (!raw) return INBOX_BODY_MAX_BYTES_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : INBOX_BODY_MAX_BYTES_DEFAULT;
}

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

function deriveClawDirFromInboxDir(inboxDir: string): string {
  const normalized = path.normalize(inboxDir);
  // phase 364 D3 (review-2026-06-13): 同 outbox-writer 修。保 leading `/`、
  // 否则 split+filter+join 形成 doubled path 写错位置。
  const isAbsolute = path.isAbsolute(normalized);
  const parts = normalized.split(path.sep).filter(p => p.length > 0);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    if (
      (secondLast === 'inbox' && (last === 'pending' || last === 'dead-letter')) ||
      (secondLast === 'outbox' && last === 'pending')
    ) {
      const joined = parts.slice(0, -2).join(path.sep) || '.';
      return isAbsolute && joined !== '.' ? path.sep + joined : joined;
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
    this.counter = getSharedSequenceCounter(fs, deriveClawDirFromInboxDir(inboxDir));
  }

  /** Internal factory — only callable within the Messaging module. */
  static __internal_create(fs: FileSystem, inboxDir: InboxPath, audit: AuditLog): InboxWriter {
    return new InboxWriter(fs, inboxDir, audit);
  }

  /** async 写，atomic */
  async write(msg: InboxMessage, extraFields?: Record<string, string>): Promise<void> {
    let filename: string | undefined;
    try {
      // phase 273 Step A: schema invariant (violation emit audit、不 throw、不阻 write、保 IO 错 throw)
      assertMessageShape(msg, this.audit, 'inbox', 'write');

      // phase 933: wire size limit covers the encoded payload (body + metadata + extraFields)
      const encoded = encodeInbox(msg, extraFields);
      const wireSize = Buffer.byteLength(encoded, 'utf-8');
      const maxBytes = getInboxBodyMaxBytes();
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
      const seq = await this.counter.next();
      const randomSuffix = newShortUuid().slice(0, 6);
      filename = `${source}-${timestamp}_${priority}_${formatSeq(seq)}_${randomSuffix}.md`;
      const filePath = path.join(this.inboxDir, filename);
      await this.fs.writeAtomic(filePath, encoded);
      emitInboxWritten(this.audit, { file: filename as string, to: msg.to, contractId: msg.metadata?.contract_id });
    } catch (e) {
      const reason = formatErr(e);
      emitInboxWriteFailed(this.audit, { file: filename ?? '<unknown>', to: msg.to, reason, contractId: msg.metadata?.contract_id });
      throw e;
    }
  }

  /** sync 写，供 task/system 同步路径使用 */
  writeSync(opts: InboxMessageOptionsBase): string {
    const now = new Date();
    const priority = opts.priority ?? 'normal';
    const timestamp = String(now.getTime()).padStart(15, '0');
    const idPrefix = opts.idPrefix ?? opts.type;

    const message: InboxMessage = {
      id: `${idPrefix}-${newUuid()}`,
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
    const maxBytes = getInboxBodyMaxBytes();
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
      const seq = this.counter.nextSync();
      const randomSuffix = newShortUuid().slice(0, 6);
      filename = `${source}-${timestamp}_${priority}_${formatSeq(seq)}_${randomSuffix}.md`;
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


