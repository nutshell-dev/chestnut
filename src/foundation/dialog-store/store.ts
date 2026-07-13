/**
 * DialogStore - Manages Claw conversation sessions
 * 
 * Handles:
 * - current.json read/write
 * - Session archiving
 * - Crash recovery from archive
 */

const ARCHIVE_SUBDIR_DEFAULT = 'archive';
/** Default archive sub-directory name (when caller doesn't inject) */
const CORRUPTED_SUBDIR = 'corrupted';
/** Sub-directory name for isolated corrupt dialog artifacts */

import * as path from 'path';
import { formatErr } from "../node-utils/index.js";
import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';

import type { Message, ToolUseBlock, ToolResultBlock, ToolDefinition } from '../llm-provider/types.js';
import type { SessionData, LoadResult, DialogMarker, RestoreResult } from './types.js';
import type { TraceId } from '../audit/types.js';
import type { AuditLog } from '../audit/types.js';
import { DIALOG_AUDIT_EVENTS } from './audit-events.js';
import { newShortUuid } from  '../node-utils/index.js';
import { DialogStoreError, DialogIOError, CorruptionError } from './errors.js';

import { detectAndMigrateVersion, validateSessionData } from './validate.js';
import { CURRENT_DIALOG_FILE } from './dirs.js';
import { repairMessages } from './repair.js';
import { restoreMessages } from './restore.js';
import { assertDialogShapeInvariants } from './invariants.js';

/**
 * loadStable() retry base delay（ms）.
 * 检测 mtime+size 不变以确认 read 稳定时、重试退避 base = N × (attempt+1) ms.
 */
const LOAD_STABLE_RETRY_BASE_DELAY_MS = 50;

/**
 * Default retry count for loadStable + loadStableTurnBoundary mid-write race protection.
 */
const LOAD_STABLE_DEFAULT_RETRIES = 3;

/**
 * Manages a Claw's dialog session
 */
export class DialogStore {
  private readonly currentPath: string;
  private readonly archiveDir: string;
  private createdAt: string | null = null;
  private corruptedPoisoned: boolean = false;
  private flushPromise: Promise<void> = Promise.resolve();
  private prevMessagesLength: number | undefined = undefined;

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
    this.archiveDir = path.join(dialogDir, archiveDir ?? ARCHIVE_SUBDIR_DEFAULT);
  }

  /**
   * Load session from disk
   * - Returns current.json if exists
   * - Otherwise recovers latest archive (cold start)
   * - Returns empty session if nothing found
   */
  async load(): Promise<LoadResult> {
    if (this.corruptedPoisoned) {
      if (await this.fs.exists(this.currentPath)) {
        // Phase 984: a fresh save (or transient I/O recovery) made current.json available again.
        // Reset poison and retry the normal load path instead of skipping straight to archive.
        this.corruptedPoisoned = false;
      } else {
        const archived = await this.loadLatestArchive();
        if (archived) {
          // phase 597: 加 to forensic col、明示 recover 目标（与 CORRUPTED 'file=current.json' 对齐）
          this.audit.write(DIALOG_AUDIT_EVENTS.RECOVERED, `from=${archived.name}`, `to=current.json`);
          this.createdAt = archived.session.createdAt;
          this.prevMessagesLength = archived.session.messages.length;
          return { session: archived.session, source: 'archive' };
        }
        return this.coldStart();
      }
    }

    // Try current.json first
    try {
      const content = await this.fs.read(this.currentPath);
      try {
        const parsed = JSON.parse(content) as Partial<SessionData>;
        const detected = detectAndMigrateVersion(parsed, CURRENT_DIALOG_FILE, this.audit);
        if (detected === null) {
          this.audit.write(DIALOG_AUDIT_EVENTS.CORRUPTED, 'file=current.json', `reason=version_unknown`);
          throw new DialogStoreError('session version unknown');
        }
        const data = this.validateSession(detected);
        // Cache createdAt for subsequent saves
        this.createdAt = data.createdAt;
        this.prevMessagesLength = data.messages.length;
        return { session: data, source: 'current' };
      } catch (parseErr) {
        // Data corruption: isolate the bad file and recover from archive.
        this.audit.write(DIALOG_AUDIT_EVENTS.CORRUPTED, 'file=current.json', `reason=${formatErr(parseErr)}`);
        try {
          const ts = Date.now();
          await this.fs.move(this.currentPath, `${this.currentPath}.corrupted.${ts}_${newShortUuid()}`);
        } catch (renameErr) {
          this.audit.write(
            DIALOG_AUDIT_EVENTS.CORRUPTED_ISOLATE_FAILED,
            `path=${this.currentPath}`,
            `reason=${formatErr(renameErr)}`,
          );
        }
        this.corruptedPoisoned = true;
      }
    } catch (err) {
      if (isFileNotFound(err)) {
        // Cold start: missing file is expected; fall through to archive recovery.
      } else {
        // I/O error (e.g. EIO/EACCES): propagate without isolating the file.
        this.audit.write(
          DIALOG_AUDIT_EVENTS.LOAD_FAILED,
          `file=current.json`,
          `code=${(err as NodeJS.ErrnoException).code ?? 'unknown'}`,
          `reason=${formatErr(err)}`,
        );
        return { source: 'io_error', error: formatErr(err), session: null };
      }
    }

    // Recovery from archive (current missing or corrupted)
    try {
      const archived = await this.loadLatestArchive();
      if (archived) {
        // phase 597: 加 to forensic col、明示 recover 目标（与 CORRUPTED 'file=current.json' 对齐）
        this.audit.write(DIALOG_AUDIT_EVENTS.RECOVERED, `from=${archived.name}`, `to=current.json`);
        this.createdAt = archived.session.createdAt;
        this.prevMessagesLength = archived.session.messages.length;
        return { session: archived.session, source: 'archive' };
      }
    } catch (err) {
      this.audit.write(
        DIALOG_AUDIT_EVENTS.LOAD_FAILED,
        `file=archive`,
        `code=${(err as NodeJS.ErrnoException).code ?? 'unknown'}`,
        `reason=${formatErr(err)}`,
      );
      return { source: 'io_error', error: formatErr(err), session: null };
    }

    return this.coldStart();
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
  async loadStable(maxRetries = LOAD_STABLE_DEFAULT_RETRIES): Promise<LoadResult> {
    for (let i = 0; i <= maxRetries; i++) {
      let statBefore: { size: number; mtime: number } | null = null;
      try {
        const s = await this.fs.stat(this.currentPath);
        statBefore = { size: s.size, mtime: s.mtime.getTime() };
      } catch (e) {
        if (isFileNotFound(e)) {
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
        if (isFileNotFound(e)) {
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
  async loadStableTurnBoundary(maxRetries = LOAD_STABLE_DEFAULT_RETRIES): Promise<LoadResult> {
    const result = await this.loadStable(maxRetries);
    if (result.source === 'io_error') {
      return result;
    }
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

    this.prevMessagesLength = truncated.length;

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
   * Algorithm (phase 919):
   * - Scan messages in order, recording the position of each tool_use.
   * - A tool_result only pairs with a tool_use that appears BEFORE it.
   * - Scan assistant messages reverse, find latest tool_use without a later tool_result.
   */
  private _findLastUnpairedToolUseId(messages: Message[]): string | null {
    const toolUsePositions = new Map<string, number>();
    const paired = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block.type === 'tool_use' && (block as ToolUseBlock).id) {
          toolUsePositions.set((block as ToolUseBlock).id, i);
        }
        if (block.type === 'tool_result') {
          const tuId = (block as ToolResultBlock).tool_use_id;
          if (toolUsePositions.has(tuId) && toolUsePositions.get(tuId)! < i) {
            paired.add(tuId);
          }
        }
      }
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      const content = Array.isArray(msg.content) ? msg.content : null;
      if (!content) continue;
      for (const block of content) {
        if (block.type === 'tool_use') {
          const id = (block as ToolUseBlock).id;
          if (!paired.has(id)) {
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
  async save(
    snapshot: {
      systemPrompt: string;
      messages: Message[];
      toolsForLLM: ToolDefinition[];
      trace_id?: TraceId;
    },
  ): Promise<void> {
    const doSave = async (): Promise<void> => {
      // phase 227: schema invariant check（违例 emit audit、不 throw、不阻 save）
      assertDialogShapeInvariants(snapshot.messages, this.audit);

      // length 单调 check
      const prev = this.prevMessagesLength;
      if (prev !== undefined && Array.isArray(snapshot.messages) && snapshot.messages.length < prev) {
        this.audit.write(
          DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED,
          `kind=length_regressed`,
          `prev=${prev}`,
          `curr=${snapshot.messages.length}`,
        );
      }
      this.prevMessagesLength = Array.isArray(snapshot.messages) ? snapshot.messages.length : undefined;

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
    const wrapped = next.catch(() => {
      // silent: chain serialize guard (phase 1024 G.2) — original error visible via `await next` to caller; swallow only prevents this.flushPromise chain from breaking for next save
    });
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
    const loadResult = await this.load();
    if (loadResult.source === 'io_error') {
      throw new Error(`Session load failed: ${loadResult.error}`);
    }
    const { session } = loadResult;
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
    // phase 227: rollback 是 intentional regression、reset prevLength 防 length_regressed 误报
    this.prevMessagesLength = messages.length;
    await this.save({ systemPrompt, messages, toolsForLLM });
    this._turnSnapshot = null;
    this.audit.write(
      DIALOG_AUDIT_EVENTS.TURN_ROLLBACK,
      reason ? `reason=${reason}` : 'reason=unknown',
    );
  }

  /**
   * Archive current session (move to archive dir)
   *
   * Phase 920: archive 必须排在 flushPromise 串行链之后，先 drain 所有 pending save，
   * 再执行 move，防止 save() 与 archive() 重叠导致 "current.json 被 move 走后又被新 save
   * 重建" 的竞态。同时完整重置新会话的状态缓存。
   */
  async archive(): Promise<void> {
    // Phase 920: drain pending saves before archiving.
    // Prevents race where a concurrent save() creates a new current.json
    // after we move the old one.
    await this.flushPromise;

    const doArchive = async (): Promise<void> => {
      // Ensure archive directory exists
      await this.fs.ensureDir(this.archiveDir);

      // Phase 985: archive idempotency — current.json may already have been moved
      // away by a prior attempt. Treat as no-op and reset the in-memory state so
      // subsequent saves start a fresh session.
      const currentExists = await this.fs.exists(this.currentPath);
      if (!currentExists) {
        this.audit.write(DIALOG_AUDIT_EVENTS.ARCHIVE_ALREADY_ARCHIVED, `path=${this.currentPath}`);
        this.createdAt = null;
        this.corruptedPoisoned = false;
        this.prevMessagesLength = 0;
        return;
      }

      // Generate archive filename with timestamp and UUID suffix to avoid collisions
      const timestamp = Date.now();
      const archivePath = path.join(this.archiveDir, `${timestamp}_${newShortUuid()}.json`);

      // Move current.json to archive
      await this.fs.move(this.currentPath, archivePath);

      // Phase 920: 完整重置新会话状态缓存
      this.createdAt = null;  // Reset so next save() starts a fresh session
      // phase 988 (audit-2026-05-17 NEW.P1 G.2): reset corruptedPoisoned 防 sticky
      // archive 移走 current.json → 下次 load cold start → 新 file 不继承 stale poisoned state
      this.corruptedPoisoned = false;
      // Phase 920: reset message length cache for new session
      this.prevMessagesLength = 0;
    };

    // Chain archive after flushPromise to serialize with any new saves.
    const next = this.flushPromise.then(doArchive, doArchive);
    const wrapped = next.catch((err) => {
      this.audit.write(
        DIALOG_AUDIT_EVENTS.ARCHIVE_FAILED,
        `path=${this.currentPath}`,
        `reason=${formatErr(err)}`,
      );
      // swallow: keep flushPromise chain alive for subsequent saves
    });
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
      if (isFileNotFound(err)) {
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
      if (isFileNotFound(err)) {
        return false;
      }
      throw err;
    }
  }

  /**
   * 读取指定 archive 文件，返完整 SessionData。
   * 内部自动做 detectAndMigrateVersion + validateSession。
   * @throws 文件不存在时底层 fs 抛 ENOENT/FS_NOT_FOUND
   * @throws 文件格式损坏时抛 CorruptionError（含 corrupted 隔离 + audit）
   * @throws 读取 I/O 错误时抛 DialogIOError
   */
  async readArchive(filename: string): Promise<SessionData> {
    const safeName = path.basename(filename); // strip any directory components
    if (safeName !== filename || safeName === '..' || safeName === '.') {
      throw new DialogStoreError(`Invalid archive filename: "${filename}"`);
    }
    const filePath = path.join(this.archiveDir, safeName);
    // Defensive: verify resolved path is within archiveDir
    if (!filePath.startsWith(this.archiveDir + path.sep)) {
      throw new DialogStoreError(`Path traversal detected: "${filename}"`);
    }

    let content: string;
    try {
      content = await this.fs.read(filePath);
    } catch (err) {
      if (isFileNotFound(err)) throw err;
      throw new DialogIOError(`I/O error reading archive: ${formatErr(err)}`, err);
    }

    try {
      const parsed = JSON.parse(content) as Partial<SessionData>;
      const detected = detectAndMigrateVersion(parsed, filename, this.audit);
      if (detected === null) {
        this.audit.write(DIALOG_AUDIT_EVENTS.CORRUPTED, `file=${filename}`, `reason=version_unknown`);
        throw new CorruptionError(`session version unknown in archive ${filename}`, null);
      }
      return this.validateSession(detected);
    } catch (err) {
      if (isFileNotFound(err)) {
        throw err; // should not happen since read() succeeded, but keep defensive
      }
      if (err instanceof DialogIOError) {
        throw err; // already typed, do not re-classify as corruption
      }
      // Data corruption (parse / version / validation): isolate and re-throw as CorruptionError.
      const corruptedErr = err instanceof CorruptionError
        ? err
        : new CorruptionError(`Corrupted archive: ${formatErr(err)}`, err);
      try {
        await this.fs.ensureDir(path.join(this.archiveDir, CORRUPTED_SUBDIR));
        await this.fs.move(filePath, path.join(this.archiveDir, CORRUPTED_SUBDIR, safeName));
        this.audit.write(DIALOG_AUDIT_EVENTS.CORRUPTED, `file=${filename}`, `isolated=corrupted/${filename}`);
      } catch (moveErr) {
        this.audit.write(
          DIALOG_AUDIT_EVENTS.CORRUPTED_ISOLATE_FAILED,
          `path=${filePath}`,
          `reason=${formatErr(moveErr)}`,
        );
      }
      throw corruptedErr;
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
    let entries;
    try {
      entries = await this.fs.list(this.archiveDir);
    } catch (err) {
      if (isFileNotFound(err)) {
        // Archive directory does not exist yet — equivalent to empty archive.
        this.audit.write(DIALOG_AUDIT_EVENTS.ARCHIVE_EMPTY);
        return null;
      }
      // I/O error listing the archive directory must propagate, not be treated as "no archives".
      this.audit.write(
        DIALOG_AUDIT_EVENTS.ARCHIVE_READ_FAILED,
        `dir=${this.archiveDir}`,
        `reason=${formatErr(err)}`,
      );
      throw err;
    }

    const files = entries
      .filter((e) => e.isFile && e.name.endsWith('.json') && !isNaN(this.parseArchiveTimestamp(e.name)))
      .sort((a, b) => this.parseArchiveTimestamp(b.name) - this.parseArchiveTimestamp(a.name)); // newest first

    for (const entry of files) {
      const filePath = path.join(this.archiveDir, entry.name);
      let content: string;
      try {
        content = await this.fs.read(filePath);
      } catch (err) {
        if (isFileNotFound(err)) {
          // TOCTOU: archive vanished between list and read.
          continue;
        }
        // I/O error reading an archive file propagates.
        throw err;
      }

      try {
        const parsed = JSON.parse(content) as Partial<SessionData>;
        const detected = detectAndMigrateVersion(parsed, entry.name, this.audit);
        if (detected === null) {
          this.audit.write(DIALOG_AUDIT_EVENTS.ARCHIVE_PARSE_FAILED, `file=${entry.name}`, `reason=version_unknown`);
          continue;
        }
        const session = this.validateSession(detected);
        return { session, name: entry.name };
      } catch (err) {
        // Data corruption in this archive: isolate and try the next older archive.
        try {
          await this.fs.ensureDir(path.join(this.archiveDir, CORRUPTED_SUBDIR));
          await this.fs.move(filePath, path.join(this.archiveDir, CORRUPTED_SUBDIR, entry.name));
          this.audit.write(DIALOG_AUDIT_EVENTS.CORRUPTED, `file=${entry.name}`, `isolated=corrupted/${entry.name}`);
        } catch (moveErr) {
          this.audit.write(
            DIALOG_AUDIT_EVENTS.CORRUPTED_ISOLATE_FAILED,
            `path=${filePath}`,
            `reason=${formatErr(moveErr)}`,
          );
        }
        continue;
      }
    }

    if (files.length === 0) {
      this.audit.write(DIALOG_AUDIT_EVENTS.ARCHIVE_EMPTY);
    } else {
      this.audit.write(DIALOG_AUDIT_EVENTS.ARCHIVE_ALL_CORRUPTED, `scanned=${files.length}`);
    }
    return null;
  }

  /**
   * Cold start: empty session
   */
  private makeEmptySession(): SessionData {
    const now = new Date().toISOString();
    return {
      version: 2,
      ...(this.clawId !== undefined && { clawId: this.clawId }),
      createdAt: now,
      updatedAt: now,
      systemPrompt: '',
      messages: [],
      toolsForLLM: [],
    };
  }

  private coldStart(): LoadResult {
    const emptySession = this.makeEmptySession();
    this.createdAt = emptySession.createdAt;
    this.prevMessagesLength = 0;
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
    return repairMessages(messages, opts);
  }

  /**
   * Restore message prefix up to and including the marker assistant message.
   * Scans current.json then archive/*.json (newest first).
   * phase 46 Step D: delegate to restore.ts pure function.
   */
  async restore(marker: DialogMarker): Promise<RestoreResult> {
    return restoreMessages(this.fs, this.currentPath, this.archiveDir, marker, false, this.audit);
  }

  /**
   * Restore message prefix up to and including the marker assistant message.
   * phase 46 Step D: delegate to restore.ts pure function.
   */
  async restorePrefix(marker: DialogMarker): Promise<RestoreResult> {
    return restoreMessages(this.fs, this.currentPath, this.archiveDir, marker, true, this.audit);
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

// phase 46 Step B: re-export 保直接从 store.js import 的 caller 0 改（barrel 透明）
export { MarkerNotFoundError, migrateAndValidateSession, validateSessionData } from './validate.js';
