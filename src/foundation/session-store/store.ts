/**
 * SessionManager - Manages Claw conversation sessions
 * 
 * Handles:
 * - current.json read/write
 * - Session archiving
 * - Token estimation
 * - Crash recovery from archive
 */

import * as path from 'path';
import type { IFileSystem } from '../fs/types.js';

import type { Message, ToolUseBlock, ToolResultBlock } from '../../types/message.js';
import type { SessionData } from './types.js';
import { randomUUID } from 'crypto';

/**
 * Session manager configuration
 */
export interface SessionManagerOptions {
  /** Path to dialog directory (relative to fs base) */
  dialogDir: string;
}

/**
 * Manages a Claw's conversation session
 */
export class SessionManager {
  private readonly currentPath: string;
  private readonly archiveDir: string;
  private createdAt: string | null = null;
  
  constructor(
    private readonly fs: IFileSystem,
    dialogDir: string,
    private readonly clawId: string = randomUUID(),
  ) {
    this.currentPath = path.join(dialogDir, 'current.json');
    this.archiveDir = path.join(dialogDir, 'archive');
  }

  /**
   * Load session from disk
   * - Returns current.json if exists
   * - Otherwise recovers latest archive (cold start)
   * - Returns empty session if nothing found
   */
  async load(): Promise<SessionData> {
    // Try current.json first
    try {
      const content = await this.fs.read(this.currentPath);
      const data = this.validateSession(JSON.parse(content) as SessionData);
      // Cache createdAt for subsequent saves
      this.createdAt = data.createdAt;
      return data;
    } catch (err) {
      const code = (err as any).code;
      if (code === 'ENOENT' || code === 'FS_NOT_FOUND') {
        // 冷启动，文件不存在是正常的
      } else {
        console.error('[session] current.json corrupted:', err);
      }
    }

    // Try to recover from archive (cold start recovery)
    const archived = await this.loadLatestArchive();
    if (archived) {
      return archived;
    }

    // Return empty session
    const now = new Date().toISOString();
    return {
      version: 1,
      clawId: this.clawId,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  /**
   * Repair session if last assistant message has unanswered tool_use blocks.
   * Returns repaired messages + count of injected synthetic results (0 = no repair needed).
   */
  static repair(messages: Message[]): { repaired: Message[]; toolCount: number } {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return { repaired: messages, toolCount: 0 };

    const content = Array.isArray(last.content) ? last.content : [];
    const toolUseBlocks = content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use'
    );
    if (toolUseBlocks.length === 0) return { repaired: messages, toolCount: 0 };

    const syntheticResults: ToolResultBlock[] = toolUseBlocks.map(block => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: `Tool call '${block.name}' with input ${JSON.stringify(block.input)} was interrupted: process restarted.`,
      is_error: true,
    }));

    return {
      repaired: [...messages, { role: 'user', content: syntheticResults }],
      toolCount: toolUseBlocks.length,
    };
  }

  /**
   * Save session to current.json
   */
  async save(messages: Message[]): Promise<void> {
    const now = new Date().toISOString();
    
    // Use cached createdAt if available, otherwise use now
    if (!this.createdAt) {
      this.createdAt = now;
    }

    const data: SessionData = {
      version: 1,
      clawId: this.clawId,
      createdAt: this.createdAt,
      updatedAt: now,
      messages,
    };

    await this.fs.writeAtomic(this.currentPath, JSON.stringify(data, null, 2));
  }

  /**
   * Archive current session (move to archive dir)
   */
  async archive(): Promise<void> {
    // Ensure archive directory exists
    await this.fs.ensureDir(this.archiveDir);

    // Generate archive filename with timestamp and UUID suffix to avoid collisions
    const timestamp = Date.now();
    const archivePath = path.join(this.archiveDir, `${timestamp}_${randomUUID().slice(0, 8)}.json`);

    // Move current.json to archive
    await this.fs.move(this.currentPath, archivePath);
    this.createdAt = null;  // 重置，下次 save() 生成新会话时间戳
  }

  /**
   * Get current messages
   */
  async getMessages(): Promise<Message[]> {
    const session = await this.load();
    return session.messages;
  }

  /**
   * Append a message and save
   */
  async appendMessage(msg: Message): Promise<void> {
    const messages = await this.getMessages();
    messages.push(msg);
    await this.save(messages);
  }


  /**
   * Load latest archive for crash recovery
   */
  private async loadLatestArchive(): Promise<SessionData | null> {
    try {
      const entries = await this.fs.list(this.archiveDir);
      
      // Filter JSON files and sort by timestamp (descending)
      const archives = entries
        .filter(e => e.isFile && e.name.endsWith('.json'))
        .sort((a, b) => {
          const tsA = parseInt(a.name.split('.')[0], 10);
          const tsB = parseInt(b.name.split('.')[0], 10);
          return tsB - tsA; // Newest first
        });

      if (archives.length === 0) {
        return null;
      }

      // Load latest
      const latestPath = path.join(this.archiveDir, archives[0].name);
      const content = await this.fs.read(latestPath);
      try {
        const data = JSON.parse(content) as SessionData;
        return this.validateSession(data);
      } catch (parseErr) {
        console.error(`[session] Archive corrupted: ${archives[0].name}`, parseErr);
        return null;
      }
    } catch (err) {
      console.error('[session] Failed to load archive:', err);
      return null;
    }
  }

  /**
   * Validate and normalize session data
   */
  private validateSession(data: SessionData): SessionData {
    return {
      version: data.version ?? 1,
      clawId: data.clawId ?? this.clawId,
      createdAt: data.createdAt ?? new Date().toISOString(),
      updatedAt: data.updatedAt ?? new Date().toISOString(),
      messages: Array.isArray(data.messages) ? data.messages : [],
    };
  }
}
