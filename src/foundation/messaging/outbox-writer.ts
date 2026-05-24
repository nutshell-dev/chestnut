/**
 * OutboxWriter - Unified outbox message writing
 * 
 * Ensures consistent message format and file naming
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { FileSystem } from '../fs/types.js';
import type { OutboxMessage } from '../messaging/types.js';
import type { AuditLog } from '../audit/index.js';
import { encodeOutbox } from './codec-outbox.js';
import { MESSAGING_AUDIT_EVENTS } from './audit-events.js';
import { emitOutboxSent, emitOutboxSendFailed } from './audit-emit.js';
import { UUID_SHORT_LEN } from '../../constants.js';

/**
 * Outbox writer options
 */
export interface OutboxWriteOptions {
  type: 'response' | 'contract_update' | 'status_report' | 'report' | 'question' | 'result' | 'error';
  to: string;
  content: string;
  contract_id?: string;
  priority?: 'critical' | 'high' | 'normal' | 'low';
}

/**
 * Outbox message writer
 */
export class OutboxWriter {
  private readonly outboxDir: string;

  constructor(
    private readonly clawId: string,
    private readonly clawDir: string,
    private readonly fs: FileSystem,
    private readonly audit: AuditLog,
  ) {
    this.outboxDir = path.join(clawDir, 'outbox', 'pending');
  }

  /**
   * Write a message to outbox
   * @returns Path to the written file
   */
  async write(options: OutboxWriteOptions): Promise<string> {
    // Generate message
    const message: OutboxMessage = {
      id: randomUUID(),
      type: options.type,
      from: this.clawId,
      to: options.to,
      content: options.content,
      timestamp: new Date().toISOString(),
      priority: options.priority ?? 'normal',
      contract_id: options.contract_id,
    };

    // Generate filename: {timestamp}_{type}_{uuid}.md
    const timestamp = Date.now();
    const typeSlug = options.type.toLowerCase();
    const filename = `${timestamp}_${typeSlug}_${message.id.slice(0, UUID_SHORT_LEN)}.md`;
    const filePath = path.join(this.outboxDir, filename);

    // Format content as markdown
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
        contractId: options.contract_id,
      });
      return filePath;
    } catch (err) {
      emitOutboxSendFailed(this.audit, {
        from: this.clawId,
        to: options.to,
        type: options.type,
        id: message.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
