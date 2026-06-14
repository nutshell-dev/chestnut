/**
 * OutboxWriter - Unified outbox message writing
 * 
 * Ensures consistent message format and file naming
 */

import * as path from 'path';
import { formatErr } from "../utils/index.js";
import type { FileSystem } from '../fs/types.js';
import type { OutboxMessage } from '../messaging/types.js';
import type { AuditLog } from '../audit/index.js';
import { encodeOutbox } from './codec-outbox.js';
import { emitOutboxSent, emitOutboxSendFailed } from './audit-emit.js';
import { assertMessageShape } from './invariants.js';
import { SequenceCounter, formatSeq } from './sequence-counter.js';
import type { ClawId } from '../../constants.js';


/**
 * Outbox writer options
 */
export interface OutboxWriteOptions {
  type: 'report' | 'question' | 'result' | 'error';
  to: string;
  content: string;
  metadata?: Record<string, string>;
  priority?: 'critical' | 'high' | 'normal' | 'low';
}

/** Branded outbox directory path — only makeOutboxPath() can construct. */
declare const OutboxPathBrand: unique symbol;
export type OutboxPath = string & { readonly [OutboxPathBrand]: true };

/** Factory: construct an OutboxPath from a clawId and clawDir. */
export function makeOutboxPath(clawId: ClawId, clawDir: string): OutboxPath {
  void clawId; // semantic param — aligns with createOutboxWriter signature
  return path.join(clawDir, 'outbox', 'pending') as OutboxPath;
}

function deriveClawDirFromOutboxDir(outboxDir: string): string {
  const normalized = path.normalize(outboxDir);
  // phase 364 D3 (review-2026-06-13): 保 leading `/` 给 POSIX absolute path、
  // 否则 split+filter+join 会 strip 前导分隔符 → SequenceCounter 拿到 relative
  // path → fs.resolve(baseDir + relative) 形成 doubled path
  // (<clawDir>/<clawDir-without-slash>/.next-msg-seq)。
  const isAbsolute = path.isAbsolute(normalized);
  const parts = normalized.split(path.sep).filter(p => p.length > 0);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    if (secondLast === 'outbox' && last === 'pending') {
      const joined = parts.slice(0, -2).join(path.sep) || '.';
      return isAbsolute && joined !== '.' ? path.sep + joined : joined;
    }
  }
  return normalized || '.';
}

/**
 * Outbox message writer
 */
export class OutboxWriter {
  private readonly counter: SequenceCounter;

  private constructor(
    private readonly clawId: ClawId,
    private readonly outboxDir: OutboxPath,
    private readonly fs: FileSystem,
    private readonly audit: AuditLog,
  ) {
    this.counter = new SequenceCounter(fs, deriveClawDirFromOutboxDir(outboxDir));
  }

  /** Internal factory — only callable within the Messaging module. */
  static __internal_create(clawId: ClawId, outboxDir: OutboxPath, fs: FileSystem, audit: AuditLog): OutboxWriter {
    return new OutboxWriter(clawId, outboxDir, fs, audit);
  }

  /**
   * Write a message to outbox
   * @returns Path to the written file
   */
  async write(options: OutboxWriteOptions): Promise<string> {
    // Generate message
    const seq = this.counter.nextSync();
    const message: OutboxMessage = {
      id: `${this.clawId}-${seq}`,
      type: options.type,
      from: this.clawId,
      to: options.to,
      content: options.content,
      timestamp: new Date().toISOString(),
      priority: options.priority ?? 'normal',
      metadata: options.metadata,
    };

    // Generate filename: {timestamp}_{type}_{seq}.md
    const timestamp = Date.now();
    const typeSlug = options.type.toLowerCase();
    const filename = `${timestamp}_${typeSlug}_${formatSeq(seq)}.md`;
    const filePath = path.join(this.outboxDir, filename);

    // Format content as markdown
    // phase 273 Step A:
    assertMessageShape(message, this.audit, 'outbox', 'write');

    const content = encodeOutbox(message);

    try {
      // Ensure directory exists
      await this.fs.ensureDir(this.outboxDir);
      // Write file
      await this.fs.writeAtomic(filePath, content);
      emitOutboxSent(this.audit, {
        from: this.clawId,
        to: options.to,
        type: options.type,
        id: message.id,
        contractId: options.metadata?.contract_id,
      });
      return filePath;
    } catch (err) {
      emitOutboxSendFailed(this.audit, {
        from: this.clawId,
        to: options.to,
        type: options.type,
        id: message.id,
        reason: formatErr(err),
      });
      throw err;
    }
  }
}
