/**
 * OutboxWriter - Unified outbox message writing
 * 
 * Ensures consistent message format and file naming
 */

import * as path from 'path';
import { formatErr, newUuid } from "../node-utils/index.js";
import type { FileSystem } from '../fs/index.js';
import type { OutboxMessage } from '../messaging/types.js';
import type { AuditLog } from '../audit/index.js';
import { encodeOutbox } from './codec-outbox.js';
import { emitOutboxSent, emitOutboxSendFailed, emitOutboxBodyOversize } from './audit-emit.js';
import { assertMessageShape } from './invariants.js';
import type { ClawId } from '../claw-identity/index.js';


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
// Derivation: 64 KiB (与 INBOX_BODY_MAX_BYTES_DEFAULT 一致、统一上限) / outbox typical use
// case (status report / result) ≤ 4KB / env CHESTNUT_OUTBOX_BODY_MAX_BYTES 覆盖.
const OUTBOX_BODY_MAX_BYTES_DEFAULT = 64 * 1024;
function getOutboxBodyMaxBytes(): number {
  const raw = process.env.CHESTNUT_OUTBOX_BODY_MAX_BYTES;
  if (!raw) return OUTBOX_BODY_MAX_BYTES_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : OUTBOX_BODY_MAX_BYTES_DEFAULT;
}

/** Branded outbox directory path — only makeOutboxPath() can construct. */
declare const OutboxPathBrand: unique symbol;
export type OutboxPath = string & { readonly [OutboxPathBrand]: true };

/** Factory: construct an OutboxPath from a clawId and clawDir. */
export function makeOutboxPath(clawId: ClawId, clawDir: string): OutboxPath {
  void clawId; // semantic param — aligns with createOutboxWriter signature
  return path.join(clawDir, 'outbox', 'pending') as OutboxPath;
}

/**
 * Outbox message writer
 */
export class OutboxWriter {
  private constructor(
    private readonly clawId: ClawId,
    private readonly outboxDir: OutboxPath,
    private readonly fs: FileSystem,
    private readonly audit: AuditLog,
  ) {}

  /** Internal factory — only callable within the Messaging module. */
  static __internal_create(clawId: ClawId, outboxDir: OutboxPath, fs: FileSystem, audit: AuditLog): OutboxWriter {
    return new OutboxWriter(clawId, outboxDir, fs, audit);
  }

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
      const maxBytes = getOutboxBodyMaxBytes();
      if (wireSize > maxBytes) {
        emitOutboxBodyOversize(this.audit, {
          clawId: this.clawId,
          to: options.to,
          type: options.type,
          bodySize: Buffer.byteLength(options.content, 'utf-8'),
          wireSize,
          cap: maxBytes,
          contractId: options.metadata?.contract_id,
        });
        throw new Error(`Outbox wire size ${wireSize} bytes exceeds cap ${maxBytes} (env CHESTNUT_OUTBOX_BODY_MAX_BYTES to override)`);
      }

      // Generate filename: {timestamp}_{type}_{messageUuid}.md
      const timestamp = Date.now();
      const typeSlug = options.type.toLowerCase();
      const filename = `${timestamp}_${typeSlug}_${messageUuid}.md`;
      const filePath = path.join(this.outboxDir, filename);

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
        id: messageId,
        reason: formatErr(err),
        contractId: options.metadata?.contract_id,
      });
      throw err;
    }
  }
}


export function createOutboxWriter(
  clawId: ClawId,
  clawDir: string,
  fs: FileSystem,
  audit: AuditLog,
): OutboxWriter {
  return OutboxWriter.__internal_create(clawId, makeOutboxPath(clawId, clawDir), fs, audit);
}
