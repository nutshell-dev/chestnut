/**
 * OutboxWriter - Unified outbox message writing
 * 
 * Ensures consistent message format and file naming
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { FileSystem } from '../fs/types.js';
import type { OutboxMessage } from '../../types/contract.js';
import type { Audit } from '../audit/index.js';
import { encodeOutbox } from '../message-codec/index.js';
import { AUDIT_EVENTS } from '../audit/events.js';

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
  private outboxDir: string;

  constructor(
    private clawId: string,
    private clawDir: string,
    private fs: FileSystem,
    private audit: Audit,
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
    const filename = `${timestamp}_${typeSlug}_${message.id.slice(0, 8)}.md`;
    const filePath = path.join(this.outboxDir, filename);

    // Format content as markdown
    const content = encodeOutbox(message);

    try {
      // Ensure directory exists
      await this.fs.ensureDir(this.outboxDir);
      // Write file
      await this.fs.writeAtomic(filePath, content);
      this.audit.write(
        AUDIT_EVENTS.OUTBOX_SENT,
        `from=${this.clawId}`,
        `to=${options.to}`,
        `type=${options.type}`,
        `id=${message.id}`,
        ...(options.contract_id ? [`contract_id=${options.contract_id}`] : []),
      );
      return filePath;
    } catch (err) {
      this.audit.write(
        AUDIT_EVENTS.OUTBOX_SEND_FAILED,
        `from=${this.clawId}`,
        `to=${options.to}`,
        `type=${options.type}`,
        `id=${message.id}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}
