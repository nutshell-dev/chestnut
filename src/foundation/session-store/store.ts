/**
 * SessionManager - Manages Claw conversation sessions
 * 
 * Handles:
 * - current.json read/write
 * - Session archiving
 * - Crash recovery from archive
 */

import * as path from 'path';
import type { IFileSystem } from '../fs/types.js';

import type { Message, ToolUseBlock, ToolResultBlock } from '../../types/message.js';
import type { SessionData, LoadResult } from './types.js';
import type { IAuditSink } from '../audit/index.js';
import { randomUUID } from 'crypto';

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
    private readonly audit?: IAuditSink,
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
  async load(): Promise<LoadResult> {
    // Try current.json first
    try {
      const content = await this.fs.read(this.currentPath);
      const data = this.validateSession(JSON.parse(content) as SessionData);
      // Cache createdAt for subsequent saves
      this.createdAt = data.createdAt;
      return { session: data, source: 'current' };
    } catch (err) {
      const code = (err as any).code;
      if (code === 'ENOENT' || code === 'FS_NOT_FOUND') {
        // Cold start: missing file is expected
      } else {
        this.audit?.write('session_corrupted', 'file=current.json', `reason=${err instanceof Error ? err.message : String(err)}`);
        // Rename corrupted file so subsequent loads don't retry parsing it
        try {
          await this.fs.move(this.currentPath, this.currentPath + '.corrupted');
        } catch (renameErr) {
          console.warn('[session] failed to rename corrupted file:', renameErr instanceof Error ? renameErr.message : String(renameErr));
        }
      }
    }

    // Try to recover from archive (cold start recovery)
    const archived = await this.loadLatestArchive();
    if (archived) {
      this.audit?.write('session_recovered', `from=${archived.name}`);
      return { session: archived.session, source: 'archive' };
    }

    // Return empty session
    const now = new Date().toISOString();
    const emptySession: SessionData = {
      version: 1,
      clawId: this.clawId,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    return { session: emptySession, source: 'empty' };
  }

  /**
   * Repair session if last assistant message has unanswered tool_use blocks.
   *
   * Injects synthetic `tool_result` blocks for each unanswered `tool_use` so the
   * LLM can continue the conversation.
   *
   * @param messages - Current session messages.
   * @param opts.interruptionMessage - Optional explanation of the interruption
   *   (e.g. shutdown reason + timeline discovered by the caller). When omitted or
   *   empty, the synthetic message explicitly states "Cause unknown (no context
   *   provided to repair)." — a fail-loud default that reminds callers to pass
   *   context when available. SessionStore does not guess the interruption cause.
   * @returns Repaired messages and count of injected synthetic results.
   *   `toolCount` is 0 when the input messages are returned unchanged.
   */
  static repair(
    messages: Message[],
    opts?: { interruptionMessage?: string },
  ): { repaired: Message[]; toolCount: number } {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return { repaired: messages, toolCount: 0 };

    const content = Array.isArray(last.content) ? last.content : null;
    if (!content) return { repaired: messages, toolCount: 0 };
    const toolUseBlocks = content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use'
    );
    if (toolUseBlocks.length === 0) return { repaired: messages, toolCount: 0 };

    const detail = opts?.interruptionMessage && opts.interruptionMessage.length > 0
      ? opts.interruptionMessage
      : 'Cause unknown (no context provided to repair).';

    const syntheticResults: ToolResultBlock[] = toolUseBlocks.map(block => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: `Tool call '${block.name}' with input ${JSON.stringify(block.input)} was interrupted. ${detail}`,
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
    this.createdAt = null;  // Reset so next save() starts a fresh session
  }

  /**
   * Load latest archive for crash recovery
   */
  private async loadLatestArchive(): Promise<{ session: SessionData; name: string } | null> {
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

      // Load latest, falling back to older archives if corrupted
      for (const entry of archives) {
        const entryPath = path.join(this.archiveDir, entry.name);
        try {
          const content = await this.fs.read(entryPath);
          const data = JSON.parse(content) as SessionData;
          return { session: this.validateSession(data), name: entry.name };
        } catch (parseErr) {
          this.audit?.write('session_corrupted', `file=${entry.name}`, `reason=${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
          console.error(`[session] Archive corrupted: ${entry.name}`, parseErr);
          // Continue to next archive
        }
      }
      return null;
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
