/**
 * InboxReader - Inbox message processor (Messaging L2)
 *
 * Pure message pull and file management. No file-watching.
 * - drainInbox(): read pending, sort by priority, return entries
 * - markDone/markFailed: move files to done/ or failed/
 *
 * File-watching orchestration lives in Runtime (assembly layer).
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { IFileSystem } from '../fs/types.js';
import type { InboxMessage } from '../../types/contract.js';
import { PRIORITY_VALUES } from '../../types/contract.js';
import { decodeInbox } from '../message-codec/index.js';

export interface InboxEntry {
  message: InboxMessage;
  filePath: string;
}

export class InboxReader {
  constructor(
    private readonly pendingDir: string,
    private readonly doneDir: string,
    private readonly failedDir: string,
    private readonly fs: IFileSystem,
  ) {}

  /** Ensure inbox directories exist */
  async init(): Promise<void> {
    await this.fs.ensureDir(this.pendingDir);
    await this.fs.ensureDir(this.doneDir);
    await this.fs.ensureDir(this.failedDir);
  }

  /**
   * Read all pending messages, sorted by priority (desc) then timestamp (asc).
   * Returns messages with their file paths for subsequent markDone/markFailed calls.
   */
  async drainInbox(): Promise<InboxEntry[]> {
    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(this.pendingDir, { includeDirs: false });
    } catch (err: any) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[InboxReader] Failed to list pending messages:', err);
      }
      return [];
    }

    const results: InboxEntry[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const filePath = this.pendingDir + '/' + entry.name;
      try {
        const content = await this.fs.read(filePath);
        const message = decodeInbox(content);
        results.push({ message, filePath });
      } catch (err) {
        console.warn(`[InboxReader] Malformed message, moving to failed/ ${filePath}:`, err);
        await this.markFailed(filePath);
      }
    }

    results.sort((a, b) => {
      const pa = PRIORITY_VALUES[a.message.priority] ?? PRIORITY_VALUES.normal;
      const pb = PRIORITY_VALUES[b.message.priority] ?? PRIORITY_VALUES.normal;
      if (pa !== pb) return pb - pa; // Higher priority first
      const ta = new Date(a.message.timestamp).getTime() || 0;
      const tb = new Date(b.message.timestamp).getTime() || 0;
      return ta - tb; // Older first (FIFO)
    });

    return results;
  }

  /** Move processed file to done/ */
  async markDone(filePath: string): Promise<void> {
    try {
      const fileName = path.basename(filePath);
      const uuid8 = randomUUID().slice(0, 8);
      const targetPath = path.join(this.doneDir, `${Date.now()}_${uuid8}_${fileName}`);
      await this.fs.move(filePath, targetPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[InboxReader] Failed to move ${filePath} to done:`, msg);
    }
  }

  /** Move failed file to failed/ */
  async markFailed(filePath: string): Promise<void> {
    try {
      const fileName = path.basename(filePath);
      const uuid8 = randomUUID().slice(0, 8);
      const targetPath = path.join(this.failedDir, `${Date.now()}_${uuid8}_${fileName}`);
      await this.fs.move(filePath, targetPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[InboxReader] Failed to move ${filePath} to failed:`, msg);
    }
  }
}
