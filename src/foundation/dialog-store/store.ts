/**
 * DialogStore - Manages Claw conversation sessions
 * 
 * Handles:
 * - current.json read/write
 * - Session archiving
 * - Crash recovery from archive
 */

import * as path from 'path';
import { formatErr } from "../utils/index.js";
import type { FileSystem } from '../fs/types.js';

import type { Message, ToolUseBlock, ToolResultBlock, ToolDefinition } from '../llm-provider/types.js';
import type { SessionData, LoadResult, DialogMarker, RestoreResult } from './types.js';
import type { AuditLog } from '../audit/index.js';
import { DIALOG_AUDIT_EVENTS } from './audit-events.js';
import { randomUUID } from 'crypto';
import { UUID_SHORT_LEN } from '../../constants.js';
import type { ToolUseId } from '../tool-protocol/index.js';
import { detectAndMigrateVersion, validateSessionData, MarkerNotFoundError } from './validate.js';

/**
 * loadStable() retry base delay（ms）.
 * 检测 mtime+size 不变以确认 read 稳定时、重试退避 base = N × (attempt+1) ms.
 */
const LOAD_STABLE_RETRY_BASE_DELAY_MS = 50;

/**
 * Manages a Claw's dialog session
 */
export class DialogStore {
  private readonly currentPath: string;
  private readonly archiveDir: string;
  private createdAt: string | null = null;
  private corruptedPoisoned: boolean = false;
  private flushPromise: Promise<void> = Promise.resolve();

  // phase 1285: turn transaction snapshot (memory-based)
  private _turnSnapshot: {
    messages: Message[];
    systemPrompt: string;
    toolsForLLM: ToolDefinition[];
  } | null = null;

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
      const detected = detectAndMigrateVersion(parsed, 'current.json', this.audit);
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
        this.audit.write(DIALOG_AUDIT_EVENTS.CORRUPTED, 'file=current.json', `reason=${formatErr(err)}`);
        // Rename corrupted file so subsequent loads don't retry parsing it
        try {
          await this.fs.move(this.currentPath, this.currentPath + '.corrupted');
        } catch (renameErr) {
          this.audit.write(
            DIALOG_AUDIT_EVENTS.CORRUPTED_ISOLATE_FAILED,
            `path=${this.currentPath}`,
            `reason=${formatErr(renameErr)}`,
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
   *
   * 隐式契约（phase 1400 ratify）：返回的 promise 仅在链式 flush 全部 settled 时 resolve、
   * 不传播 reject — save 失败由 phase 1024 G.2 chain wrapper swallow 防 chain 破裂。
   * caller 需通过 `await store.save(...)` 直接感知单次 save 的 reject、`getFlushPromise()` 仅作
   * barrier 等「全部 settled」信号、不可用于错误传播。
   */
  getFlushPromise(): Promise<void> {
    return this.flushPromise;
  }

  /**
   * Load session with mtime consistency check.
   * phase 1102 r126: prevents reading incomplete session during concurrent save().
   */
  async loadStable(maxRetries = 3): Promise<LoadResult> {
    for (let i = 0; i <= maxRetries; i++) {
      let statBefore: { size: number; mtime: number } | null = null;
      try {
        const s = await this.fs.stat(this.currentPath);
        statBefore = { size: s.size, mtime: s.mtime.getTime() };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'FS_NOT_FOUND') {
          // File doesn't exist — load() will cold-start; no race possible
          return this.load();
        }
        throw e;
      }

      const result = await this.load();

      let statAfter: { size: number; mtime: number } | null = null;
      try {
        const s = await this.fs.stat(this.currentPath);
        statAfter = { size: s.size, mtime: s.mtime.getTime() };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'FS_NOT_FOUND') {
          // File was archived/removed between load and stat — result is still valid
          return result;
        }
        throw e;
      }

      if (
        statBefore !== null &&
        statAfter !== null &&
        statBefore.size === statAfter.size &&
        statBefore.mtime === statAfter.mtime
      ) {
        return result;
      }

      if (i < maxRetries) {
        await new Promise(r => setTimeout(r, LOAD_STABLE_RETRY_BASE_DELAY_MS * (i + 1)));
      }
    }

    // Exceeded retries: fall back to plain load() — audit for observability
    this.audit.write(
      DIALOG_AUDIT_EVENTS.CORRUPTED,
      'file=current.json',
      `reason=load_stable_exhausted_after_${maxRetries}_retries`,
    );
    return this.load();
  }

  /**
   * Load session with mtime consistency check + truncate to last complete turn boundary.
   *
   * phase 1184: protects against mid-turn 逻辑边界 race where Motion saves between
   * tool_use emission and tool_result completion → snapshot contains unpaired tool_use
   * → caller LLM API 400 (e.g., Kimi/Anthropic "tool_calls must be followed by tool messages").
   *
   * Returns Message[] callable as LLM API messages parameter without 400 errors:
   * - If last assistant message contains tool_use blocks with no matching tool_result
   *   in subsequent user messages, truncate the unpaired assistant message + everything after
   * - Pairing matched by tool_use_id field
   * - 0 truncate if snapshot already at paired boundary
   *
   * Caller: cross-claw read of motion's dialog snapshot at LLM call time
   * (currently ask-motion.ts; future cross-claw readers can adopt this method).
   */
  async loadStableTurnBoundary(maxRetries = 3): Promise<LoadResult> {
    const result = await this.loadStable(maxRetries);
    const messages = result.session.messages;

    // Scan backwards for last unpaired tool_use
    const unpairedToolUseId = this._findLastUnpairedToolUseId(messages);
    if (unpairedToolUseId === null) {
      return result;  // already at paired boundary
    }

    // Find truncate point: the index of the assistant message containing unpaired tool_use
    let truncateFromIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      const content = Array.isArray(msg.content) ? msg.content : null;
      if (!content) continue;
      const hasUnpaired = content.some(
        (b) => b.type === 'tool_use' && b.id === unpairedToolUseId,
      );
      if (hasUnpaired) {
        truncateFromIdx = i;
        break;
      }
    }

    if (truncateFromIdx === -1) {
      // Defensive: scan inconsistent, return original (should not happen given findLastUnpairedToolUseId returned non-null)
      return result;
    }

    const truncated = messages.slice(0, truncateFromIdx);
    const truncatedCount = messages.length - truncated.length;

    this.audit.write(
      DIALOG_AUDIT_EVENTS.TURN_BOUNDARY_TRUNCATED,
      `truncated_count=${truncatedCount}`,
      `unpaired_tool_use_id=${unpairedToolUseId}`,
      `last_complete_turn_idx=${truncateFromIdx - 1}`,
    );

    return {
      ...result,
      session: {
        ...result.session,
        messages: truncated,
      },
    };
  }

  /**
   * Find the tool_use_id of the last unpaired tool_use in messages.
   * Returns null if all tool_use are paired.
   *
   * Algorithm:
   * - Collect tool_use_id set from assistant messages
   * - Collect tool_result tool_use_id set from user messages (after each tool_use's assistant message)
   * - Return the latest (highest index) tool_use_id not in tool_result set
   */
  private _findLastUnpairedToolUseId(messages: Message[]): string | null {
    const seenToolResultIds = new Set<string>();
    // Scan all messages first, collect all tool_result IDs
    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const content = Array.isArray(msg.content) ? msg.content : null;
      if (!content) continue;
      for (const block of content) {
        if (block.type === 'tool_result') {
          seenToolResultIds.add((block as ToolResultBlock).tool_use_id);
        }
      }
    }
    // Scan assistant messages reverse, find latest tool_use without matching tool_result
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      const content = Array.isArray(msg.content) ? msg.content : null;
      if (!content) continue;
      for (const block of content) {
        if (block.type === 'tool_use') {
          const id = (block as ToolUseBlock).id;
          if (!seenToolResultIds.has(id)) {
            return id;
          }
        }
      }
    }
    return null;
  }

  /**
   * Save session to current.json
   * phase 713: 扩 snapshot 参 / atomic write systemPrompt + messages + toolsForLLM 3 件
   */
  async save(snapshot: {
    systemPrompt: string;
    messages: Message[];
    toolsForLLM: ToolDefinition[];
    trace_id?: string;
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
        ...(snapshot.trace_id && { trace_id: snapshot.trace_id }),
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
          `reason=${formatErr(err)}`,
        );
        throw err;
      }
    };
    // phase 1024 G.2: serialize concurrent save() — chain into flushPromise / catch swallow per-link 防 chain 破裂
    const next = this.flushPromise.then(doSave, doSave);  // 失败也继续 doSave / chain 不破
    const wrapped = next.catch(() => { /* swallow / 防 chain 破裂、caller 仍看到 original error via await next */ });
    this.flushPromise = wrapped;
    // phase 1082: cap flushPromise chain growth — reset to resolved when quiescent
    wrapped.then(() => {
      if (this.flushPromise === wrapped) {
        this.flushPromise = Promise.resolve();
      }
    }).catch((e) => {
      this.audit.write(DIALOG_AUDIT_EVENTS.FLUSH_CHAIN_ERROR, `reason=${formatErr(e)}`);
    });
    return next;
  }

  /**
   * Begin a turn transaction.
   * Captures current in-memory state as rollback point.
   * All save() calls within the turn are accumulated in memory;
   * commitTurn() flushes atomically, rollbackTurn() restores snapshot.
   */
  async beginTurn(): Promise<void> {
    const { session } = await this.load();
    this._turnSnapshot = {
      messages: JSON.parse(JSON.stringify(session.messages)) as Message[],
      systemPrompt: session.systemPrompt,
      toolsForLLM: JSON.parse(JSON.stringify(session.toolsForLLM)) as ToolDefinition[],
    };
    this.audit.write(DIALOG_AUDIT_EVENTS.TURN_BEGIN);
  }

  /**
   * Commit turn transaction: snapshot is discarded; save() already wrote incrementally.
   * No-op if no transaction in progress.
   */
  async commitTurn(reason?: string): Promise<void> {
    if (!this._turnSnapshot) return;
    this._turnSnapshot = null;
    this.audit.write(
      DIALOG_AUDIT_EVENTS.TURN_COMMIT,
      reason ? `reason=${reason}` : 'reason=normal_end',
    );
  }

  /**
   * Rollback turn transaction: restore dialog to beginTurn() snapshot.
   * Guarantees Phase 1105 all-or-nothing rollback semantics.
   */
  async rollbackTurn(reason?: string): Promise<void> {
    if (!this._turnSnapshot) return;
    const { messages, systemPrompt, toolsForLLM } = this._turnSnapshot;
    await this.save({ systemPrompt, messages, toolsForLLM });
    this._turnSnapshot = null;
    this.audit.write(
      DIALOG_AUDIT_EVENTS.TURN_ROLLBACK,
      reason ? `reason=${reason}` : 'reason=unknown',
    );
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
        `reason=${formatErr(err)}`,
      );
      throw err;
    }
  }

  /**
   * 列举所有已归档 session 文件名（按 mtime 升序）。
   * 返文件名列表（仅文件名，不含路径），如 `['1711234567890_abc123.json', ...]`。
   * archive 目录不存在时返空数组（不抛错）。
   */
  async listArchives(): Promise<string[]> {
    try {
      const entries = await this.fs.list(this.archiveDir);
      return entries
        .filter((e) => e.isFile && e.name.endsWith('.json') && !isNaN(this.parseArchiveTimestamp(e.name)))
        .sort((a, b) => this.parseArchiveTimestamp(a.name) - this.parseArchiveTimestamp(b.name)) // oldest first
        .map((e) => e.name);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'FS_NOT_FOUND') {
        return [];
      }
      throw err;
    }
  }

  /**
   * 检查 current.json 是否存在。
   * 只读检查，不触发 cold start / archive 恢复。
   */
  async hasCurrent(): Promise<boolean> {
    try {
      await this.fs.stat(this.currentPath);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'FS_NOT_FOUND') {
        return false;
      }
      throw err;
    }
  }

  /**
   * 读取指定 archive 文件，返完整 SessionData。
   * 内部自动做 detectAndMigrateVersion + validateSession。
   * @throws 文件不存在时底层 fs 抛 ENOENT/FS_NOT_FOUND
   * @throws 文件格式损坏时抛 error（含 corrupted 隔离 + audit）
   */
  async readArchive(filename: string): Promise<SessionData> {
    const filePath = path.join(this.archiveDir, filename);
    try {
      const content = await this.fs.read(filePath);
      const parsed = JSON.parse(content) as Partial<SessionData>;
      const detected = detectAndMigrateVersion(parsed, filename, this.audit);
      if (detected === null) {
        this.audit.write(DIALOG_AUDIT_EVENTS.CORRUPTED, `file=${filename}`, `reason=version_unknown`);
        throw new Error(`session version unknown in archive ${filename}`);
      }
      return this.validateSession(detected);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'FS_NOT_FOUND') {
        throw err; // 文件不存在，直接抛出让 caller 处理
      }
      // 其他错误（parse / version / validation）——尝试隔离到 corrupted
      try {
        await this.fs.ensureDir(path.join(this.archiveDir, 'corrupted'));
        await this.fs.move(filePath, path.join(this.archiveDir, 'corrupted', filename));
        this.audit.write(DIALOG_AUDIT_EVENTS.CORRUPTED, `file=${filename}`, `isolated=corrupted/${filename}`);
      } catch (moveErr) {
        this.audit.write(
          DIALOG_AUDIT_EVENTS.CORRUPTED_ISOLATE_FAILED,
          `path=${filePath}`,
          `reason=${formatErr(moveErr)}`,
        );
      }
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
          const detected = detectAndMigrateVersion(parsed, entry.name, this.audit);
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
            `reason=${formatErr(err)}`,
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
        `reason=${formatErr(err)}`,
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

    const syntheticResults: ToolResultBlock[] = toolUseBlocks.map(block => {
      let inputDesc: string;
      try {
        inputDesc = JSON.stringify(block.input);
      } catch {
        // silent: cyclic reference guard — fallback to unserializable placeholder
        inputDesc = '<unserializable>';
      }
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Tool call '${block.name}' with input ${inputDesc} was interrupted. ${detail}`,
        is_error: true,
      };
    });

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
      const detected = detectAndMigrateVersion(parsed, 'current.json', this.audit);
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
          `reason=${formatErr(err)}`,
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
          const detected = detectAndMigrateVersion(parsed, entry.name, this.audit);
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
            `reason=${formatErr(err)}`,
          );
          // 单个 archive 损坏跳过 / 继续找
        }
      }
    } catch (err) {
      this.audit.write(
        DIALOG_AUDIT_EVENTS.ARCHIVE_DIR_FAILED,
        `reason=${formatErr(err)}`,
      );
      // archive dir 失败 / 走最终抛错
    }

    // 3. 找不到
    throw new MarkerNotFoundError(marker.clawId, marker.toolUseId);
  }

  /**
   * Validate and normalize session data
   * phase 1400: 委托 validateSessionData / 消 DRY 违反 / clawId fallback 来源传 this.clawId
   * phase 46 Step B: validateSessionData 迁至 validate.ts
   */
  private validateSession(data: SessionData): SessionData {
    return validateSessionData(data, this.audit, this.clawId);
  }
}

/**
 * 找含 toolUseId 的 assistant message / 返切片（含该 message）
 * 0 命中返 null
 */
function sliceMessagesAtMarker(messages: Message[], toolUseId: ToolUseId, inclusive = true): Message[] | null {
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

// phase 46 Step B: re-export 保直接从 store.js import 的 caller 0 改（barrel 透明）
export { MarkerNotFoundError, migrateAndValidateSession, validateSessionData } from './validate.js';
