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
  emitInboxBodyOversize,
} from './audit-emit.js';
import { assertMessageShape } from './invariants.js';
import { SequenceCounter, formatSeq } from './sequence-counter.js';
import { ok, err as errResult, type Result } from '../utils/index.js';
import type { InboxMetaError } from './errors.js';
import { isFileNotFound } from '../fs/types.js';

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
    this.counter = new SequenceCounter(fs, deriveClawDirFromInboxDir(inboxDir));
  }

  /** Internal factory — only callable within the Messaging module. */
  static __internal_create(fs: FileSystem, inboxDir: InboxPath, audit: AuditLog): InboxWriter {
    return new InboxWriter(fs, inboxDir, audit);
  }

  /** async 写，atomic */
  async write(msg: InboxMessage, extraFields?: Record<string, string>): Promise<void> {
    // phase 430 Step A (phase 429 follow-up、review medium): async write 对称 body cap、防 disk DoS
    const bodySize = Buffer.byteLength(msg.content, 'utf-8');
    const maxBytes = getInboxBodyMaxBytes();
    if (bodySize > maxBytes) {
      emitInboxBodyOversize(this.audit, {
        source: msg.from,
        to: msg.to,
        type: msg.type,
        bodySize,
        cap: maxBytes,
        contractId: msg.metadata?.contract_id,
      });
      throw new Error(`Inbox body size ${bodySize} bytes exceeds cap ${maxBytes} (env CHESTNUT_INBOX_BODY_MAX_BYTES to override)`);
    }
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
      emitInboxWriteFailed(this.audit, { file: filename, to: msg.to, reason, contractId: msg.metadata?.contract_id });
      throw e;
    }
    emitInboxWritten(this.audit, { file: filename, to: msg.to, contractId: msg.metadata?.contract_id });
  }

  /** sync 写，供 task/system 同步路径使用 */
  writeSync(opts: InboxMessageOptionsBase): void {
    // phase 429 Step A (review medium): inbox body 硬上限、防 disk DoS / runaway bug
    const bodySize = Buffer.byteLength(opts.body, 'utf-8');
    const maxBytes = getInboxBodyMaxBytes();
    if (bodySize > maxBytes) {
      emitInboxBodyOversize(this.audit, {
        source: opts.source,
        to: opts.to,
        type: opts.type,
        bodySize,
        cap: maxBytes,
        contractId: opts.metadata?.contract_id,
      });
      throw new Error(`Inbox body size ${bodySize} bytes exceeds cap ${maxBytes} (env CHESTNUT_INBOX_BODY_MAX_BYTES to override)`);
    }
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
      emitInboxWriteFailed(this.audit, { file: filename, to: opts.to, reason, contractId: opts.metadata?.contract_id });
      throw e;
    }
    emitInboxWritten(this.audit, { file: filename, to: opts.to, contractId: opts.metadata?.contract_id });
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


