/**
 * LocalTransport - ITransport implementation using local file system
 * 
 * Directory structure:
 * {workspaceDir}/
 *   claws/
 *     {clawId}/
 *       inbox/
 *         pending/     - New messages
 *         done/        - Processed messages
 *         failed/      - Failed messages
 *       heartbeat.json - Last heartbeat
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import type {
  ITransport,
  InboxMessage,
  InboxStatus,
} from './index.js';
import type { HeartbeatEntry, Priority } from '../../types/contract.js';
import { PRIORITY_VALUES } from '../../types/contract.js';
import { writeAtomic } from '../fs/atomic.js';
import { createWatcher } from '../file-watcher/watcher.js';
import type { Watcher } from '../file-watcher/types.js';
import { parseFrontmatter } from '../../utils/frontmatter.js';
import { validatePriority, validateType } from '../message-codec/index.js';
import { encodeInbox } from '../message-codec/index.js';

/**
 * Local transport configuration
 */
export interface LocalTransportOptions {
  /** Base workspace directory */
  workspaceDir: string;
}



/**
 * Local file system transport implementation
 */
export class LocalTransport implements ITransport {
  private readonly workspaceDir: string;
  private readonly clawsDir: string;
  private watchers: Map<string, Watcher> = new Map();
  private closed = false;

  constructor(options: LocalTransportOptions) {
    this.workspaceDir = options.workspaceDir;
    this.clawsDir = path.join(this.workspaceDir, 'claws');
  }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  /**
   * Initialize directory structure
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.clawsDir, { recursive: true });
  }

  /**
   * Close transport and cleanup
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    // Close all watchers
    for (const watcher of this.watchers.values()) {
      await watcher.close();
    }
    this.watchers.clear();
  }

  // ========================================================================
  // Inbox Operations
  // ========================================================================

  /**
   * Send message to claw's inbox
   */
  async sendInboxMessage(clawId: string, msg: InboxMessage): Promise<void> {
    this.ensureNotClosed();

    const inboxDir = this.getInboxDir(clawId);
    const pendingDir = path.join(inboxDir, 'pending');
    await fs.mkdir(pendingDir, { recursive: true });

    // Generate filename: {timestamp}_{priority}_{uuid}.md (MVP aligned)
    const timestamp = Date.now();
    const priority = msg.priority ?? 'normal';
    const filename = `${timestamp}_${priority}_${randomUUID().slice(0, 8)}.md`;
    const filePath = path.join(pendingDir, filename);

    await writeAtomic(filePath, encodeInbox(msg));
  }

  /**
   * Read inbox messages
   */
  async readInbox(
    clawId: string,
    options?: {
      limit?: number;
      since?: Date;
      unreadOnly?: boolean;
    }
  ): Promise<InboxMessage[]> {
    this.ensureNotClosed();

    const inboxDir = this.getInboxDir(clawId);
    const pendingDir = path.join(inboxDir, 'pending');

    const messages: Array<{ msg: InboxMessage; priority: number; timestamp: number }> = [];

    try {
      const files = await fs.readdir(pendingDir);

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(pendingDir, file);
        const content = await fs.readFile(filePath, 'utf-8');

        try {
          const { meta, body } = parseFrontmatter(content);
          const msg: InboxMessage = {
            id: meta.id ?? randomUUID(),
            type: validateType(meta.type),
            from: meta.from ?? 'unknown',
            to: meta.to ?? '',
            content: body,
            priority: validatePriority(meta.priority),
            timestamp: meta.timestamp ?? new Date().toISOString(),
            contract_id: meta.contract_id,
          };

          // Filter by date
          if (options?.since && new Date(msg.timestamp) < options.since) {
            continue;
          }

          // Parse filename for priority and timestamp
          const parts = file.split('_');
          const timestamp = parseInt(parts[0], 10) || Date.now();
          const priority = PRIORITY_VALUES[parts[1] as Priority] ?? PRIORITY_VALUES.normal;

          messages.push({ msg, priority, timestamp });
        } catch (err) {
          console.warn(`[transport] Skip unparseable message: ${file}`, err);
          continue;
        }
      }
    } catch {
      // Directory doesn't exist yet
      return [];
    }

    // Sort by priority (desc), then by timestamp (asc)
    messages.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority; // Higher priority first
      }
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(); // Older first
    });

    let result = messages.map(m => m.msg);

    // Apply limit
    if (options?.limit && options.limit > 0) {
      result = result.slice(0, options.limit);
    }

    return result;
  }

  /**
   * Mark message as read (move pending -> done)
   */
  async markAsRead(clawId: string, messageId: string): Promise<void> {
    this.ensureNotClosed();

    const inboxDir = this.getInboxDir(clawId);
    const pendingDir = path.join(inboxDir, 'pending');
    const doneDir = path.join(inboxDir, 'done');

    await fs.mkdir(doneDir, { recursive: true });

    // Find file by message ID
    const files = await fs.readdir(pendingDir);
    let found = false;

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const filePath = path.join(pendingDir, file);
      const content = await fs.readFile(filePath, 'utf-8');

      try {
        const { meta } = parseFrontmatter(content);
        if (meta.id === messageId) {
          // Move to done
          const donePath = path.join(doneDir, file);
          await fs.rename(filePath, donePath);
          found = true;
          break;
        }
      } catch (err) {
        console.warn(`[transport] Failed to ack message, file: ${file}, err: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    if (!found) {
      throw new Error(`Message ${messageId} not found in inbox`);
    }
  }

  /**
   * Get inbox status
   */
  async getInboxStatus(clawId: string): Promise<InboxStatus> {
    this.ensureNotClosed();

    const inboxDir = this.getInboxDir(clawId);
    const pendingDir = path.join(inboxDir, 'pending');

    let total = 0;
    let highPriority = 0;
    let oldestMessage: string | undefined;

    try {
      const files = await fs.readdir(pendingDir);

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(pendingDir, file);
        const content = await fs.readFile(filePath, 'utf-8');

        try {
          const { meta } = parseFrontmatter(content);
          total++;

          const priority = validatePriority(meta.priority);
          if (priority === 'high' || priority === 'critical') {
            highPriority++;
          }

          const timestamp = meta.timestamp;
          if (timestamp && (!oldestMessage || timestamp < oldestMessage)) {
            oldestMessage = timestamp;
          }
        } catch (err) {
          console.warn(`[transport] getInboxStatus skip: ${file}`, err);
          continue;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[transport] getInboxStatus failed:', err);
      }
    }

    return {
      total,
      unread: total,
      highPriority,
      oldestMessage,
    };
  }

  /**
   * Watch inbox for new messages
   */
  async watchInbox(
    clawId: string,
    callback: (message: InboxMessage) => void
  ): Promise<() => Promise<void>> {
    this.ensureNotClosed();

    const inboxDir = this.getInboxDir(clawId);
    const pendingDir = path.join(inboxDir, 'pending');
    await fs.mkdir(pendingDir, { recursive: true });

    const watcher = createWatcher(
      pendingDir,
      async (event) => {
        if (event.type === 'add' && event.path.endsWith('.md')) {
          try {
            const content = await fs.readFile(event.path, 'utf-8');
            const { meta, body } = parseFrontmatter(content);

            const validatedType = validateType(meta.type);
            const validatedPriority = validatePriority(meta.priority);

            const msg: InboxMessage = {
              id: meta.id ?? randomUUID(),
              type: validatedType,
              from: meta.from ?? 'unknown',
              to: meta.to ?? '',
              content: body,
              priority: validatedPriority,
              timestamp: meta.timestamp ?? new Date().toISOString(),
              contract_id: meta.contract_id,
            };
            callback(msg);
          } catch (err) {
            console.warn(`[transport] watchInbox skip: ${event.path}`, err);
          }
        }
      },
      { recursive: false }
    );

    this.watchers.set(`${clawId}-inbox`, watcher);

    // Return cleanup function
    return async () => {
      await watcher.close();
      this.watchers.delete(`${clawId}-inbox`);
    };
  }

  // ========================================================================
  // Health Monitoring
  // ========================================================================

  /**
   * Send heartbeat
   */
  async sendHeartbeat(entry: HeartbeatEntry): Promise<void> {
    this.ensureNotClosed();

    const clawDir = path.join(this.clawsDir, entry.claw_id);
    await fs.mkdir(clawDir, { recursive: true });

    const hbPath = path.join(clawDir, 'heartbeat.json');
    await writeAtomic(hbPath, JSON.stringify(entry, null, 2));
  }

  /**
   * Check if claw is alive
   */
  async isClawAlive(clawId: string): Promise<boolean> {
    this.ensureNotClosed();

    const clawDir = path.join(this.clawsDir, clawId);
    try {
      const stat = await fs.stat(clawDir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Get all active claws
   */
  async getActiveClaws(): Promise<string[]> {
    this.ensureNotClosed();

    try {
      const entries = await fs.readdir(this.clawsDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private getInboxDir(clawId: string): string {
    return path.join(this.clawsDir, clawId, 'inbox');
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new Error('Transport is closed');
    }
  }
}
