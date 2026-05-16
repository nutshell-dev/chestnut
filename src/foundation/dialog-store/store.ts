/**
 * DialogStore - Manages Claw conversation sessions
 * 
 * Handles:
 * - current.json read/write
 * - Session archiving
 * - Crash recovery from archive
 */

import * as path from 'path';
import type { FileSystem } from '../fs/types.js';

import type { Message, ToolUseBlock, ToolResultBlock, ToolDefinition } from '../../types/message.js';
import type { SessionData, LoadResult, DialogMarker, RestoreResult } from './types.js';
import type { AuditLog } from '../audit/index.js';
import { DIALOG_AUDIT_EVENTS } from './audit-events.js';
import { randomUUID } from 'crypto';
import { UUID_SHORT_LEN } from '../../constants.js';

/**
 * Manages a Claw's dialog session
 */
export class DialogStore {
  private readonly currentPath: string;
  private readonly archiveDir: string;
  private createdAt: string | null = null;
  private corruptedPoisoned: boolean = false;

  constructor(
    private readonly fs: FileSystem,
    dialogDir: string,
    private readonly audit: AuditLog,
    filename: string,                                 // phase 450: 必填 / caller 注入
    private readonly clawId?: string,                 // phase 450: 可选 / subagent ephemeral 用例 0 clawId
    archiveDir?: string,                              // phase 450: 可选 / 默认 'archive' subdir 保兼容
  ) {
    this.currentPath = path.join(dialogDir, filename);
    this.archiveDir = path.join(dialogDir, archiveDir ?? 'archive');
  }

  /**
   * Load session from disk
   * - Returns current.json if exists
   * - Otherwise recovers latest archive (cold start)
   * - Returns empty session if nothing found
   */
  async load(): Promise<LoadResult> {
    if (this.corruptedPoisoned) {
      const archived = await this.loadLatestArchive();
      if (archived) {
        this.audit.write(DIALOG_AUDIT_EVENTS.RECOVERED, `from=${archived.name}`);
        return { session: archived.session, source: 'archive' };
      }
      return this.coldStart();
    }

    // Try current.json first
    try {
      const content = await this.fs.read(this.currentPath);
      const parsed = JSON.parse(content) as Partial<SessionData>;
      // v1 → v2 schema 兼容 read（phase 713）
      if (!parsed.toolsForLLM) {
        (parsed as SessionData).toolsForLLM = [];
        (parsed as SessionData).version = 2;
      }
      const data = this.validateSession(parsed as SessionData);
      // Cache createdAt for subsequent saves
      this.createdAt = data.createdAt;
      return { session: data, source: 'current' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'FS_NOT_FOUND') {
        // Cold start: missing file is expected
      } else {
        this.audit.write(DIALOG_AUDIT_EVENTS.CORRUPTED, 'file=current.json', `reason=${err instanceof Error ? err.message : String(err)}`);
        // Rename corrupted file so subsequent loads don't retry parsing it
        try {
          await this.fs.move(this.currentPath, this.currentPath + '.corrupted');
        } catch (renameErr) {
          this.audit.write(
            DIALOG_AUDIT_EVENTS.CORRUPTED_ISOLATE_FAILED,
            `path=${this.currentPath}`,
            `reason=${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
          );
          this.corruptedPoisoned = true;
        }
      }
    }

    // Try to recover from archive (cold start recovery)
    const archived = await this.loadLatestArchive();
    if (archived) {
      this.audit.write(DIALOG_AUDIT_EVENTS.RECOVERED, `from=${archived.name}`);
      return { session: archived.session, source: 'archive' };
    }

    return this.coldStart();
  }

  private coldStart(): LoadResult {
    const now = new Date().toISOString();
    const emptySession: SessionData = {
      version: 2,
      ...(this.clawId !== undefined && { clawId: this.clawId }),  // phase 450: 0 clawId 时 schema 不含此字段
      createdAt: now,
      updatedAt: now,
      systemPrompt: '',                 // phase 713: empty session / 首次 save 时覆盖
      messages: [],
      toolsForLLM: [],                  // phase 713
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
   *   context when available. DialogStore does not guess the interruption cause.
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
   * phase 713: 扩 snapshot 参 / atomic write systemPrompt + messages + toolsForLLM 3 件
   */
  async save(snapshot: {
    systemPrompt: string;
    messages: Message[];
    toolsForLLM: ToolDefinition[];
  }): Promise<void> {
    const now = new Date().toISOString();
    
    // Use cached createdAt if available, otherwise use now
    if (!this.createdAt) {
      this.createdAt = now;
    }

    const data: SessionData = {
      version: 2,
      ...(this.clawId !== undefined && { clawId: this.clawId }),  // phase 450: 0 clawId 时 schema 不含此字段
      createdAt: this.createdAt,
      updatedAt: now,
      systemPrompt: snapshot.systemPrompt,
      messages: snapshot.messages,
      toolsForLLM: snapshot.toolsForLLM,
    };

    try {
      await this.fs.writeAtomic(this.currentPath, JSON.stringify(data, null, 2));
    } catch (err) {
      this.audit.write(
        DIALOG_AUDIT_EVENTS.SAVE_FAILED,
        `path=${this.currentPath}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Archive current session (move to archive dir)
   */
  async archive(): Promise<void> {
    try {
      // Ensure archive directory exists
      await this.fs.ensureDir(this.archiveDir);

      // Generate archive filename with timestamp and UUID suffix to avoid collisions
      const timestamp = Date.now();
      const archivePath = path.join(this.archiveDir, `${timestamp}_${randomUUID().slice(0, UUID_SHORT_LEN)}.json`);

      // Move current.json to archive
      await this.fs.move(this.currentPath, archivePath);
      this.createdAt = null;  // Reset so next save() starts a fresh session
    } catch (err) {
      this.audit.write(
        DIALOG_AUDIT_EVENTS.ARCHIVE_FAILED,
        `path=${this.currentPath}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
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
          const parsed = JSON.parse(content) as Partial<SessionData>;
          // v1 → v2 schema 兼容 read（phase 713）
          if (!parsed.toolsForLLM) {
            (parsed as SessionData).toolsForLLM = [];
            (parsed as SessionData).version = 2;
          }
          const data = this.validateSession(parsed as SessionData);
          return { session: data, name: entry.name };
        } catch (parseErr) {
          this.audit.write(
            DIALOG_AUDIT_EVENTS.CORRUPTED,
            `file=${entry.name}`,
            `reason=${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          );
          // Continue to next archive
        }
      }
      return null;
    } catch (err) {
      this.audit.write(
        DIALOG_AUDIT_EVENTS.ARCHIVE_READ_FAILED,
        `dir=${this.archiveDir}`,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Restore message prefix up to and including the marker assistant message.
   * Scans current.json then archive/*.json (newest first).
   */
  private async _restore(marker: DialogMarker, inclusive: boolean): Promise<RestoreResult> {
    // 1. Scan current.json
    try {
      const content = await this.fs.read(this.currentPath);
      const parsed = JSON.parse(content) as Partial<SessionData>;
      // v1 → v2 schema 兼容 read（phase 713）
      if (!parsed.toolsForLLM) {
        (parsed as SessionData).toolsForLLM = [];
        (parsed as SessionData).version = 2;
      }
      const data = this.validateSession(parsed as SessionData);
      const sliced = sliceMessagesAtMarker(data.messages, marker.toolUseId, inclusive);
      if (sliced !== null) {
        return {
          messages: sliced,
          systemPrompt: data.systemPrompt,
          toolsForLLM: data.toolsForLLM,
          meta: { foundIn: 'current' },
        };
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT' && code !== 'FS_NOT_FOUND') {
        this.audit.write(
          DIALOG_AUDIT_EVENTS.CORRUPTED,
          'file=current.json',
          `context=restore_${inclusive ? 'prefix' : 'before'}`,
          `reason=${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // current 不存在或损坏 / 走 archive
    }

    // 2. Scan archive/*.json (按时间倒序 / 找首个含 toolUseId 的)
    try {
      await this.fs.ensureDir(this.archiveDir);
      const entries = await this.fs.list(this.archiveDir);
      const sorted = entries
        .filter(e => e.isFile && e.name.endsWith('.json'))
        .sort((a, b) => {
          const tsA = parseInt(a.name.split('.')[0], 10);
          const tsB = parseInt(b.name.split('.')[0], 10);
          return tsB - tsA; // Newest first / 与 loadLatestArchive 一致
        });

      for (const entry of sorted) {
        try {
          const content = await this.fs.read(path.join(this.archiveDir, entry.name));
          const parsed = JSON.parse(content) as Partial<SessionData>;
          // v1 → v2 schema 兼容 read（phase 713）
          if (!parsed.toolsForLLM) {
            (parsed as SessionData).toolsForLLM = [];
            (parsed as SessionData).version = 2;
          }
          const data = this.validateSession(parsed as SessionData);
          const sliced = sliceMessagesAtMarker(data.messages, marker.toolUseId, inclusive);
          if (sliced !== null) {
            return {
              messages: sliced,
              systemPrompt: data.systemPrompt,
              toolsForLLM: data.toolsForLLM,
              meta: { foundIn: 'archive', foundFile: entry.name },
            };
          }
        } catch (err) {
          this.audit.write(
            DIALOG_AUDIT_EVENTS.ARCHIVE_PARSE_FAILED,
            `file=${entry.name}`,
            `reason=${err instanceof Error ? err.message : String(err)}`,
          );
          // 单个 archive 损坏跳过 / 继续找
        }
      }
    } catch (err) {
      this.audit.write(
        DIALOG_AUDIT_EVENTS.ARCHIVE_DIR_FAILED,
        `reason=${err instanceof Error ? err.message : String(err)}`,
      );
      // archive dir 失败 / 走最终抛错
    }

    // 3. 找不到
    throw new MarkerNotFoundError(marker.clawId, marker.toolUseId);
  }

  /**
   * Restore message prefix up to and including the marker assistant message.
   * Scans current.json then archive/*.json (newest first).
   */
  async restorePrefix(marker: DialogMarker): Promise<RestoreResult> {
    return this._restore(marker, true);
  }


  /**
   * Validate and normalize session data
   */
  private validateSession(data: SessionData): SessionData {
    return {
      version: data.version ?? 2,
      clawId: data.clawId ?? this.clawId,
      createdAt: data.createdAt ?? new Date().toISOString(),
      updatedAt: data.updatedAt ?? new Date().toISOString(),
      systemPrompt: data.systemPrompt ?? '',
      messages: Array.isArray(data.messages) ? data.messages : [],
      toolsForLLM: Array.isArray(data.toolsForLLM) ? data.toolsForLLM : [],
    };
  }
}

/**
 * 找含 toolUseId 的 assistant message / 返切片（含该 message）
 * 0 命中返 null
 */
function sliceMessagesAtMarker(messages: Message[], toolUseId: string, inclusive = true): Message[] | null {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const hasMarker = msg.content.some(
        block => block.type === 'tool_use' && block.id === toolUseId,
      );
      if (hasMarker) {
        return messages.slice(0, inclusive ? i + 1 : i);  // inclusive 含 marker assistant message
      }
    }
  }
  return null;
}

export class MarkerNotFoundError extends Error {
  constructor(
    readonly clawId: string,
    readonly toolUseId: string,
  ) {
    super(`marker not found: clawId=${clawId} toolUseId=${toolUseId}`);
    this.name = 'MarkerNotFoundError';
  }
}
