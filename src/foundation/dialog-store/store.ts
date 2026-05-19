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

const SESSION_CURRENT_VERSION = 2;

/**
 * Manages a Claw's dialog session
 */
export class DialogStore {
  private readonly currentPath: string;
  private readonly archiveDir: string;
  private createdAt: string | null = null;
  private corruptedPoisoned: boolean = false;
  private flushPromise: Promise<void> = Promise.resolve();

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
        this.createdAt = archived.session.createdAt;
        return { session: archived.session, source: 'archive' };
      }
      return this.coldStart();
    }

    // Try current.json first
    try {
      const content = await this.fs.read(this.currentPath);
      const parsed = JSON.parse(content) as Partial<SessionData>;
      const detected = this.detectAndMigrateVersion(parsed, 'current.json');
      if (detected === null) {
        this.audit.write(DIALOG_AUDIT_EVENTS.CORRUPTED, 'file=current.json', `reason=version_unknown`);
        throw new Error('session version unknown');
      }
      const data = this.validateSession(detected);
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
        }
        this.corruptedPoisoned = true;
      }

      // Recovery from archive
      const archived = await this.loadLatestArchive();
      if (archived) {
        this.audit.write(DIALOG_AUDIT_EVENTS.RECOVERED, `from=${archived.name}`);
        this.createdAt = archived.session.createdAt;
        return { session: archived.session, source: 'archive' };
      }

      return this.coldStart();
    }
  }

  /**
   * NEW pub method: await all pending save() flush
   * phase 1024 G.2: expose flushPromise for barrier (runtime.stop / SIGTERM 不丢半写)
   */
  getFlushPromise(): Promise<void> {
    return this.flushPromise;
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
    const doSave = async (): Promise<void> => {
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
        // phase 988 (audit-2026-05-17 NEW.P1 G.1): reset corruptedPoisoned 防 sticky data loss
        // save 写新 current.json → current.json 实然不再 corrupted、应然 align
        this.corruptedPoisoned = false;
      } catch (err) {
        this.audit.write(
          DIALOG_AUDIT_EVENTS.SAVE_FAILED,
          `path=${this.currentPath}`,
          `reason=${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    };
    // phase 1024 G.2: serialize concurrent save() — chain into flushPromise / catch swallow per-link 防 chain 破裂
    const next = this.flushPromise.then(doSave, doSave);  // 失败也继续 doSave / chain 不破
    this.flushPromise = next.catch(() => { /* swallow / 防 chain 破裂、caller 仍看到 original error via await next */ });
    return next;
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
      // phase 988 (audit-2026-05-17 NEW.P1 G.2): reset corruptedPoisoned 防 sticky
      // archive 移走 current.json → 下次 load cold start → 新 file 不继承 stale poisoned state
      this.corruptedPoisoned = false;
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
   * Extract numeric timestamp from archive filename.
   * Standard format: `{ts}_{uuid}.json`; parseInt stops at `_` or `.`.
   */
  private parseArchiveTimestamp(filename: string): number {
    return parseInt(filename.split('_')[0], 10);
  }

  /**
   * Load latest archive (cold start recovery)
   */
  private async loadLatestArchive(): Promise<{ session: SessionData; name: string } | null> {
    try {
      const entries = await this.fs.list(this.archiveDir);
      const files = entries
        .filter((e) => e.isFile && e.name.endsWith('.json') && !isNaN(this.parseArchiveTimestamp(e.name)))
        .sort((a, b) => this.parseArchiveTimestamp(b.name) - this.parseArchiveTimestamp(a.name)); // newest first

      for (const entry of files) {
        try {
          const content = await this.fs.read(path.join(this.archiveDir, entry.name));
          const parsed = JSON.parse(content) as Partial<SessionData>;
          const detected = this.detectAndMigrateVersion(parsed, entry.name);
          if (detected === null) {
            this.audit.write(DIALOG_AUDIT_EVENTS.ARCHIVE_PARSE_FAILED, `file=${entry.name}`, `reason=version_unknown`);
            continue;
          }
          const session = this.validateSession(detected);
          return { session, name: entry.name };
        } catch (err) {
          this.audit.write(
            DIALOG_AUDIT_EVENTS.CORRUPTED,
            `file=${entry.name}`,
            `reason=${err instanceof Error ? err.message : String(err)}`,
          );
          // Continue to next archive
        }
      }

      if (files.length === 0) {
        this.audit.write(DIALOG_AUDIT_EVENTS.ARCHIVE_EMPTY);
      } else {
        this.audit.write(DIALOG_AUDIT_EVENTS.ARCHIVE_ALL_CORRUPTED, `scanned=${files.length}`);
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
   * Cold start: empty session
   */
  private coldStart(): LoadResult {
    const now = new Date().toISOString();
    const emptySession: SessionData = {
      version: 2,
      ...(this.clawId !== undefined && { clawId: this.clawId }),
      createdAt: now,
      updatedAt: now,
      systemPrompt: '',
      messages: [],
      toolsForLLM: [],
    };
    this.createdAt = emptySession.createdAt;
    this.audit.write(DIALOG_AUDIT_EVENTS.COLD_START);
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

    const detail = opts?.interruptionMessage && opts.interruptionMessage.trim().length > 0
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
   * Restore message prefix up to and including the marker assistant message.
   * Scans current.json then archive/*.json (newest first).
   */
  async restore(marker: DialogMarker): Promise<RestoreResult> {
    return this._restore(marker, false);
  }

  /**
   * Restore message prefix up to and including the marker assistant message.
   * Scans current.json then archive/*.json (newest first).
   */
  async restorePrefix(marker: DialogMarker): Promise<RestoreResult> {
    return this._restore(marker, true);
  }

  /**
   * Shared restore implementation
   */
  private async _restore(marker: DialogMarker, inclusive: boolean): Promise<RestoreResult> {
    // 1. Scan current.json
    try {
      const content = await this.fs.read(this.currentPath);
      const parsed = JSON.parse(content) as Partial<SessionData>;
      const detected = this.detectAndMigrateVersion(parsed, 'current.json');
      if (detected === null) {
        // version unknown — treat as corrupted and fall through to archive
        throw new Error('session version unknown');
      }
      const data = this.validateSession(detected);
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
      // ensureDir 不在此调用——_restore 是只读操作，不应有 fs 副作用
      // 若 archive dir 不存在，后续 fs.list() 抛 ENOENT → catch → 抛 MarkerNotFoundError（正确语义）
      const entries = await this.fs.list(this.archiveDir);
      const sorted = entries
        .filter(e => e.isFile && e.name.endsWith('.json') && !isNaN(this.parseArchiveTimestamp(e.name)))
        .sort((a, b) => this.parseArchiveTimestamp(b.name) - this.parseArchiveTimestamp(a.name)); // Newest first / 与 loadLatestArchive 一致

      for (const entry of sorted) {
        try {
          const content = await this.fs.read(path.join(this.archiveDir, entry.name));
          const parsed = JSON.parse(content) as Partial<SessionData>;
          const detected = this.detectAndMigrateVersion(parsed, entry.name);
          if (detected === null) {
            continue; // version unknown (version > SESSION_CURRENT_VERSION)
          }
          const data = this.validateSession(detected);
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
   * Detect version and migrate v1 → v2 if needed.
   * Returns null for unknown versions (> SESSION_CURRENT_VERSION) to trigger corrupt path.
   */
  private detectAndMigrateVersion(parsed: Partial<SessionData>, filename: string): SessionData | null {
    // v1 → v2 intentional migration (phase 713 logic 保留)
    if (!parsed.toolsForLLM) {
      (parsed as SessionData).toolsForLLM = [];
      (parsed as SessionData).version = 2;
      this.audit.write(DIALOG_AUDIT_EVENTS.VERSION_MIGRATE, `file=${filename}`, `from=1`, `to=2`);
      return parsed as SessionData;
    }
    // NEW unknown version reject（phase 1019 r124 E fork）
    if (typeof parsed.version === 'number' && parsed.version > SESSION_CURRENT_VERSION) {
      this.audit.write(DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN, `file=${filename}`,
        `actual=${parsed.version}`, `current=${SESSION_CURRENT_VERSION}`);
      return null;  // caller treats as corrupt
    }
    return parsed as SessionData;
  }

  /**
   * Validate and normalize session data
   */
  private validateSession(data: SessionData): SessionData {
    // phase 1024 G.4: version 上界 invariant — supported version = 1 | 2 / version > 2 fail-loud audit
    // (version > 2 已由 detectAndMigrateVersion 拦截，此处处理 version < 1 或 undefined)
    let version: number = data.version ?? 2;
    if (typeof version !== 'number' || version > 2 || version < 1) {
      this.audit.write(
        DIALOG_AUDIT_EVENTS.INVARIANT_FAILED,
        `field=version`,
        `got=${String(data.version)}`,
        `fallback=2`,
      );
      version = 2;
    }
    if (!Number.isInteger(version)) {
      this.audit.write(
        DIALOG_AUDIT_EVENTS.INVARIANT_FAILED,
        `field=version`,
        `got=${String(data.version)}`,
        `reason=non_integer`,
      );
      version = 2;
    }
    // messages corrupt entry filter: shape check role + content
    const messages = Array.isArray(data.messages)
      ? data.messages.filter((m): m is Message => {
          const valid = m != null && typeof m === 'object' && 'role' in m && 'content' in m;
          if (!valid) {
            this.audit.write(
              DIALOG_AUDIT_EVENTS.INVARIANT_FAILED,
              `field=messages.entry`,
              `got=${typeof m}`,
              `filter=skipped`,
            );
          }
          return valid;
        })
      : [];
    return {
      version: version as SessionData['version'],
      clawId: data.clawId ?? this.clawId,
      createdAt: data.createdAt ?? new Date().toISOString(),
      updatedAt: data.updatedAt ?? new Date().toISOString(),
      systemPrompt: data.systemPrompt ?? '',
      messages,
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

/**
 * Standalone version migration + validation helpers.
 * Exported for CLI tools and deep-dream that read dialog files without a full DialogStore instance.
 * audit is optional (read-only / CLI scenarios don't need audit side-effects).
 */
export function migrateAndValidateSession(
  raw: unknown,
  filename: string,
  audit?: AuditLog,
): SessionData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parsed = raw as Partial<SessionData>;

  // v1 → v2 migration
  if (!parsed.toolsForLLM) {
    (parsed as SessionData).toolsForLLM = [];
    (parsed as SessionData).version = 2;
    audit?.write?.(DIALOG_AUDIT_EVENTS.VERSION_MIGRATE, `file=${filename}`, `from=1`, `to=2`);
  }
  // unknown version reject
  if (typeof parsed.version === 'number' && parsed.version > SESSION_CURRENT_VERSION) {
    audit?.write?.(DIALOG_AUDIT_EVENTS.VERSION_UNKNOWN, `file=${filename}`,
      `actual=${parsed.version}`, `current=${SESSION_CURRENT_VERSION}`);
    return null;
  }
  return parsed as SessionData;
}

export function validateSessionData(
  data: SessionData,
  audit?: AuditLog,
  clawIdFallback?: string,
): SessionData {
  let version: number = data.version ?? 2;
  if (typeof version !== 'number' || version > 2 || version < 1) {
    audit?.write?.(DIALOG_AUDIT_EVENTS.INVARIANT_FAILED, `field=version`, `got=${String(data.version)}`, `fallback=2`);
    version = 2;
  }
  if (!Number.isInteger(version)) {
    audit?.write?.(DIALOG_AUDIT_EVENTS.INVARIANT_FAILED, `field=version`, `got=${String(data.version)}`, `reason=non_integer`);
    version = 2;
  }
  const messages = Array.isArray(data.messages)
    ? data.messages.filter((m): m is Message => {
        const valid = m != null && typeof m === 'object' && 'role' in m && 'content' in m;
        if (!valid) {
          audit?.write?.(DIALOG_AUDIT_EVENTS.INVARIANT_FAILED, `field=messages.entry`, `got=${typeof m}`, `filter=skipped`);
        }
        return valid;
      })
    : [];
  return {
    version: version as SessionData['version'],
    clawId: data.clawId ?? clawIdFallback,
    createdAt: data.createdAt ?? new Date().toISOString(),
    updatedAt: data.updatedAt ?? new Date().toISOString(),
    systemPrompt: data.systemPrompt ?? '',
    messages,
    toolsForLLM: Array.isArray(data.toolsForLLM) ? data.toolsForLLM : [],
  };
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
