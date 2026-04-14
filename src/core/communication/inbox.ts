/**
 * InboxWatcher - Event-driven inbox message processor
 * 
 * Features:
 * - Watches inbox/pending/ for new messages
 * - Processes messages serially (one at a time)
 * - Priority-based ordering (critical > high > normal > low)
 * - Moves processed messages to done/, failed ones to failed/
 * - Cold-start recovery: processes existing pending files on start
 */

import * as path from 'path';
import { realpathSync } from 'fs';
import { randomUUID } from 'crypto';
import type { IFileSystem, FileEntry } from '../../foundation/fs/types.js';
import type { InboxMessage, Priority } from '../../types/contract.js';
import { PRIORITY_VALUES } from '../../types/contract.js';
import { createWatcher } from '../../foundation/file-watcher/watcher.js';
import type { Watcher } from '../../foundation/file-watcher/types.js';
import { INBOX_MAX_QUEUE_SIZE } from '../../constants.js';
import { decodeInbox } from '../../foundation/message-codec/index.js';

/**
 * Queued message with metadata
 */
interface QueuedMessage {
  message: InboxMessage;
  filePath: string;
  priority: number;
  timestamp: number;
}

/**
 * Inbox watcher and processor
 */
export class InboxWatcher {
  private inboxDir: string;
  private pendingDir: string;
  private doneDir: string;
  private failedDir: string;
  private watcher: Watcher | null = null;
  private queue: QueuedMessage[] = [];
  private processing = false;
  private stopped = false;
  private onMessage: ((msg: InboxMessage) => Promise<void>) | null = null;
  // 进程内去重：防止 watcher 重复触发同一文件
  // 注意：内存结构，daemon 重启后消息最多被处理一次额外（at-least-once）
  private processedFiles = new Set<string>();

  constructor(
    private clawDir: string,
    private fs: IFileSystem
  ) {
    this.inboxDir = 'inbox';
    this.pendingDir = 'inbox/pending';
    this.doneDir = 'inbox/done';
    this.failedDir = 'inbox/failed';
  }

  /**
   * Start watching and processing messages
   */
  async start(onMessage: (msg: InboxMessage) => Promise<void>): Promise<void> {
    if (this.watcher) {
      throw new Error('InboxWatcher already started');
    }

    this.onMessage = onMessage;
    this.stopped = false;

    // Ensure directories exist
    await this.fs.ensureDir(this.pendingDir);
    await this.fs.ensureDir(this.doneDir);
    await this.fs.ensureDir(this.failedDir);

    // Normalize clawDir to real path — chokidar resolves symlinks in event.path,
    // so path.relative must operate in the same realpath space
    this.clawDir = realpathSync(this.clawDir);

    // Load existing pending messages (cold-start recovery)
    await this.loadExistingMessages();

    // Start watching for new messages
    this.watcher = createWatcher(
      this.fs,
      'inbox/pending',
      (event) => {
        if (event.type === 'add' && event.path.endsWith('.md')) {
          const relativePath = path.relative(this.clawDir, event.path);
          this.handleNewFile(relativePath).catch(err => {
            console.error('[InboxWatcher] Failed to handle new file:', err);
          });
        }
      },
      { recursive: false }
    );
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.queue = [];
  }

  /**
   * Get current queue length (includes pending files not yet loaded)
   */
  async queueLength(): Promise<number> {
    // Count files in pending directory
    try {
      const entries = await this.fs.list(this.pendingDir, { includeDirs: false });
      const fileCount = entries.filter(e => e.name.endsWith('.md')).length;
      return Math.max(fileCount, this.queue.length);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.warn(`[inbox] Failed to list pending dir: ${err?.message}`);
      }
      return this.queue.length;
    }
  }

  /**
   * Load existing pending messages on startup
   */
  private async loadExistingMessages(): Promise<void> {
    try {
      const entries = await this.fs.list(this.pendingDir, { includeDirs: false });
      
      for (const entry of entries) {
        if (entry.name.endsWith('.md')) {
          await this.handleNewFile(this.pendingDir + '/' + entry.name);
        }
      }
    } catch (err: any) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[InboxWatcher] Failed to load existing messages:', err);
      }
    }
  }

  /**
   * Handle a new file in pending directory
   */
  private async handleNewFile(filePath: string): Promise<void> {
    // Normalize absolute paths to relative (defensive for test direct calls)
    if (path.isAbsolute(filePath)) {
      const realClawDir = realpathSync(this.clawDir);
      const realFilePath = realpathSync(filePath);
      filePath = path.relative(realClawDir, realFilePath);
    }

    // Deduplication: skip if already processed
    if (this.processedFiles.has(filePath)) {
      return;
    }
    this.processedFiles.add(filePath);
    
    // Queue size limit: drop lowest priority if exceeded
    if (this.queue.length >= INBOX_MAX_QUEUE_SIZE) {
      this.sortQueue();
      const dropped = this.queue.pop();  // Remove lowest priority
      if (dropped) {
        console.warn(`[inbox] Queue full, dropping: ${dropped.message.id}`);
        this.moveToFailed(dropped.filePath).catch(err =>
          console.error('[inbox] Failed to move dropped message to failed:', err)
        );
      }
    }
    
    try {
      const content = await this.fs.read(filePath);
      const message = decodeInbox(content);
      
      const queued: QueuedMessage = {
        message,
        filePath,
        priority: PRIORITY_VALUES[message.priority] ?? PRIORITY_VALUES.normal,
        timestamp: new Date(message.timestamp).getTime() || Date.now(),
      };

      // Add to queue (sorting deferred to processQueue for batch efficiency)
      this.queue.push(queued);

      // Trigger processing
      this.processQueue().catch(err => {
        console.error('[InboxWatcher] Failed to process queue:', err);
      });
    } catch (err) {
      console.warn(`[inbox] Malformed message, moving to failed/ ${filePath}:`, err);
      await this.moveToFailed(filePath);
    }
  }

  /**
   * Sort queue by priority (desc), then by timestamp (asc)
   */
  private sortQueue(): void {
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority; // Higher priority first
      }
      return a.timestamp - b.timestamp; // Older first (FIFO)
    });
  }

  /**
   * Process queue serially
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.stopped || !this.onMessage) {
      return;
    }

    // Sort once before processing all current items (batch optimization)
    if (this.queue.length > 0) {
      this.sortQueue();
    }

    this.processing = true;

    while (this.queue.length > 0 && !this.stopped) {
      const item = this.queue.shift();
      if (!item) continue;

      try {
        await this.onMessage(item.message);
        // Success: move to done
        await this.moveToDone(item.filePath);
      } catch (err) {
        // Failure: move to failed
        console.error(`[inbox] Process failed for ${item.filePath}:`, err);
        await this.moveToFailed(item.filePath);
      }
    }

    this.processing = false;
  }

  /**
   * Move processed file to done/
   */
  private async moveToDone(filePath: string): Promise<void> {
    try {
      const fileName = path.basename(filePath);
      const uuid8 = randomUUID().slice(0, 8);
      const targetPath = path.join(this.doneDir, `${Date.now()}_${uuid8}_${fileName}`);
      await this.fs.move(filePath, targetPath);
      this.processedFiles.delete(filePath); // 仅成功时移除，防止 watcher 重复触发
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[inbox] Failed to move ${filePath} to done:`, msg);
      // 清理 Set 条目，允许 daemon 重启后重试（at-least-once，与 watcher 注释一致）
      this.processedFiles.delete(filePath);
    }
  }

  /**
   * Move failed file to failed/
   */
  private async moveToFailed(filePath: string): Promise<void> {
    try {
      const fileName = path.basename(filePath);
      const uuid8 = randomUUID().slice(0, 8);
      const targetPath = path.join(this.failedDir, `${Date.now()}_${uuid8}_${fileName}`);
      await this.fs.move(filePath, targetPath);
      this.processedFiles.delete(filePath); // 仅成功时移除
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[inbox] Failed to move ${filePath} to failed:`, msg);
      this.processedFiles.delete(filePath);  // 允许重试，优先于内存泄漏
    }
  }
}
