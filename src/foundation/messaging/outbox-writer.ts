/**
 * OutboxWriter - Unified outbox message writing
 * 
 * Ensures consistent message format and file naming
 */

import * as path from 'path';
import { formatErr, newUuid } from "../node-utils/index.js";
import type { FileSystem } from '../fs/index.js';
import type { OutboxMessage } from '../messaging/types.js';
import type { MessagingAuditSink } from './audit-sink.js';
import { encodeOutbox } from './codec-outbox.js';
import { emitOutboxSent, emitOutboxSendFailed, emitOutboxBodyOversize, emitOutboxWriteDurabilityDegraded } from './audit-emit.js';
import { assertMessageShape } from './invariants.js';
import type { ClawId } from '../claw-identity/index.js';
import type { MessagingWriterLimits } from './config-schema.js';
import { OUTBOX_PENDING_DIR } from './dirs.js';


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

// phase 430 Step E (review medium、inbox cap 对称): outbox message content 硬上限、防 disk DoS
// Derivation: 64 KiB 默认（与 inbox 统一上限）/ outbox typical use case (status report /
// result) ≤ 4KB。phase 1820：上限数值归 messaging config-schema（配置 owner），
// writer 构造期注入（MessagingWriterLimits），不再读 env、不持默认值。

/**
 * Outbox message writer
 */
export class OutboxWriter {
  static create(
    clawId: ClawId,
    clawRoot: string,
    fs: FileSystem,
    audit: MessagingAuditSink,
    limits: MessagingWriterLimits,
  ): OutboxWriter {
    return new OutboxWriter(clawId, path.join(clawRoot, OUTBOX_PENDING_DIR), fs, audit, limits);
  }

  private constructor(
    private readonly clawId: ClawId,
    private readonly outboxDir: string,
    private readonly fs: FileSystem,
    private readonly audit: MessagingAuditSink,
    private readonly limits: MessagingWriterLimits,
  ) {}

  /**
   * Write a message to outbox
   * @returns Path to the written file
   */
  async write(options: OutboxWriteOptions): Promise<string> {
    // Phase 1230: single UUID is the source of both envelope id and filename suffix.
    const messageUuid = newUuid();
    let messageId = `${this.clawId}-${messageUuid}`;
    try {
      const message: OutboxMessage = {
        id: messageId,
        type: options.type,
        from: this.clawId,
        to: options.to,
        content: options.content,
        timestamp: new Date().toISOString(),
        priority: options.priority ?? 'normal',
        metadata: options.metadata,
      };

      // phase 273 Step A:
      assertMessageShape(message, this.audit, 'outbox', 'write');

      // phase 935: wire size limit covers the encoded payload (body + metadata)
      const content = encodeOutbox(message);
      const wireSize = Buffer.byteLength(content, 'utf-8');
      const maxBytes = this.limits.bodyMaxBytes;
      if (wireSize > maxBytes) {
        emitOutboxBodyOversize(this.audit, {
          clawId: this.clawId,
          to: options.to,
          id: message.id,
          type: options.type,
          bodySize: Buffer.byteLength(options.content, 'utf-8'),
          wireSize,
          cap: maxBytes,
        });
        throw new Error(`Outbox wire size ${wireSize} bytes exceeds cap ${maxBytes}`);
      }

      // Generate filename: {timestamp}_{type}_{messageUuid}.md
      const timestamp = Date.now();
      const typeSlug = options.type.toLowerCase();
      const filename = `${timestamp}_${typeSlug}_${messageUuid}.md`;
      const filePath = path.join(this.outboxDir, filename);

      // Ensure directory exists
      await this.fs.ensureDir(this.outboxDir);
      // Write file. A non-durable result means rename already committed: retain
      // outbox_sent and never roll back, but make the durability degradation audible.
      const result = await this.fs.writeAtomic(filePath, content);
      if (result.kind !== 'durable') {
        emitOutboxWriteDurabilityDegraded(this.audit, {
          file: filename,
          to: options.to,
          id: message.id,
          type: options.type,
          durability: result.kind,
          error: formatErr(result.error),
        });
      }
      emitOutboxSent(this.audit, {
        from: this.clawId,
        to: options.to,
        type: options.type,
        id: message.id,
      });
      return filePath;
    } catch (err) {
      emitOutboxSendFailed(this.audit, {
        from: this.clawId,
        to: options.to,
        type: options.type,
        id: messageId,
        reason: formatErr(err),
      });
      throw err;
    }
  }
}


export function createOutboxWriter(
  clawId: ClawId,
  clawDir: string,
  fs: FileSystem,
  audit: MessagingAuditSink,
  limits: MessagingWriterLimits,
): OutboxWriter {
  return OutboxWriter.create(clawId, clawDir, fs, audit, limits);
}
