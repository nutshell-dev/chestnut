/**
 * InboxReader - Inbox message processor (Messaging L2)
 *
 * Pure message pull and file management. No file-watching.
 * - init(): ensure 4 dirs（pending/inflight/done/failed）+ reconcile orphaned inflight → pending
 * - drainInbox(): read pending, sort by priority, return entries (legacy, no file move)
 * - drainAndDeliver(): read pending, move to inflight/, return entries + handles
 * - ack/nack: confirm or reject delivery of inflight handles
 * - peekMetas(filter?): non-consuming peek pending metas with optional priority filter
 * - findByExtraMeta(key, value, opts?): dedup query — scan pending/inflight/done within window
 * - markDone/markFailed: move files to done/ or failed/ (legacy helpers)
 *
 * File-watching orchestration lives in Runtime (assembly layer).
 */

import * as path from 'path';
import { formatErr } from "../node-utils/index.js";
import { newShortUuid } from  '../node-utils/index.js';
import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';
import type { InboxMessage, InboxHandle } from '../messaging/types.js';
import { PRIORITY_VALUES, type Priority } from '../messaging/types.js';
import { isAlive, getProcessStartTime, makeProcessStartTime } from '../process-exec/index.js';
import { decodeInbox } from './codec-inbox.js';
import type { AuditLog } from '../audit/index.js';
import {
  emitInboxDeduped,
  emitInboxDone,
  emitInboxFailed,
  emitInboxLegacyClawIdField,
  emitInboxListFailed,
  emitInboxMarkDoneFailed,
  emitInboxMetaFailed,
  emitInboxMisrouted,
  emitInboxMoveFailed,
  emitInboxNack,
  emitInboxPeekRaceSkip,
  emitInboxPriorityUnknown,
  emitInboxReconcile,
  emitOutboxDelivered,
} from './audit-emit.js';
import { InboxWriter, type InboxMessageMeta } from './inbox-writer.js';
import { makeClawId } from '../claw-identity/index.js';
import { InboxListFailed, InboxMoveFailed } from './errors.js';

// Phase 992: inbox-reader owns its transient-read error to avoid reaching into dialog-store internals.
class InboxReadError extends Error {
  constructor(message: string, readonly causeErr: unknown) {
    super(message);
    this.name = 'InboxReadError';
  }
}




function classifyErrno(err: unknown): 'ENOSPC' | 'EACCES' | 'EIO' | 'EMFILE' | 'ENOENT' | 'OTHER' {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC' || code === 'EACCES' || code === 'EIO' || code === 'EMFILE' || code === 'ENOENT') {
      return code;
    }
  }
  return 'OTHER';
}

// phase 196: inbox 状态机状态空间单源、扫描语义决策编入 switch。
// 未来加新态（如 'archived'）必触 INBOX_LOCATIONS 扩 + 编译期 assertNever
// catch missing case、自动暴露所有 helper（如本 findByExtraMeta）需做语义决策的点。
const INBOX_LOCATIONS = ['pending', 'inflight', 'done', 'failed'] as const;
export type InboxLocation = typeof INBOX_LOCATIONS[number];

/** Locations that findByExtraMeta returns on hit (failed/ scanning is by-design declined). */
export type ScannedInboxLocation = Exclude<InboxLocation, 'failed'>;

export interface InboxEntry {
  message: InboxMessage;
  filePath: string;
}

/** Phase 994: drainInbox result includes error summary for observability. */
export interface DrainInboxResult {
  entries: InboxEntry[];
  transientErrors: number;  // files kept in pending for retry (InboxReadError)
  permanentErrors: number;  // files moved to failed/
}

export class InboxReader {
  private readonly inflightDir: string;
  // phase 442: misroutedDir 隔离 to=<other_claw> 误投消息、与 done/failed 同级独立子目录
  private readonly misroutedDir: string;

  constructor(
    private readonly pendingDir: string,
    private readonly doneDir: string,
    private readonly failedDir: string,
    private readonly fs: FileSystem,
    private readonly audit: AuditLog,
    inflightDir?: string,
    misroutedDir?: string,
  ) {
    // Default inflight dir derived from pending dir: pending/ → inflight/
    this.inflightDir = inflightDir ?? pendingDir.replace(/\/pending\/?$/, '/inflight');
    // phase 442: misrouted/ 同模式推导（pending/ → misrouted/）；fallback 仍为 pendingDir 兄弟
    this.misroutedDir = misroutedDir ?? pendingDir.replace(/\/pending\/?$/, '/misrouted');
  }

  /**
   * Mint a branded InboxHandle. Only InboxReader may create handles so that
   * ack/nack/markMisrouted can rely on the handle having originated from
   * drainAndDeliver() under this reader's inflight directory.
   */
  private _makeHandle(filePath: string, originalFileName: string): InboxHandle {
    return { filePath, originalFileName } as InboxHandle;
  }

  /**
   * Validate that a handle points inside this reader's inflight directory
   * and that the original filename is a plain basename.
   * Returns the safe, normalized source path.
   */
  private _validateHandle(handle: InboxHandle): string {
    const normalized = path.normalize(handle.filePath);
    const normalizedInflight = path.normalize(this.inflightDir);

    // Reject any traversal attempt (.. segments).
    if (
      normalized === '..' ||
      normalized.startsWith('..' + path.sep) ||
      normalized.startsWith('../') ||
      normalized.endsWith(path.sep + '..') ||
      normalized.endsWith('/..') ||
      normalized.includes(path.sep + '..' + path.sep) ||
      normalized.includes('/../')
    ) {
      throw new Error(`Path traversal detected in handle: "${handle.filePath}"`);
    }

    // Ensure the path is contained within the inflight directory.
    const inflightPrefix = normalizedInflight.endsWith(path.sep)
      ? normalizedInflight
      : normalizedInflight + path.sep;
    if (!normalized.startsWith(inflightPrefix)) {
      throw new Error(`Path traversal detected in handle: "${handle.filePath}"`);
    }

    if (handle.originalFileName !== path.basename(handle.originalFileName)) {
      throw new Error(`Invalid originalFileName in handle: "${handle.originalFileName}"`);
    }
    return normalized;
  }

  /** Ensure inbox directories exist + reconcile orphaned inflight files */
  async init(): Promise<void> {
    await this.fs.ensureDir(this.pendingDir);
    await this.fs.ensureDir(this.doneDir);
    await this.fs.ensureDir(this.failedDir);
    await this.fs.ensureDir(this.inflightDir);
    await this.fs.ensureDir(this.misroutedDir);  // phase 442
    await this._reconcileInflight();
  }

  /**
   * Reconcile orphaned inflight files back to pending on startup.
   * Guarantees DP「中断可恢复」+「未经显式决策不得丢弃」。
   *
   * Phase 930: inflight filenames carry a claim lease `{pid}_{startTime}_{originalName}`.
   * Only stale claims (owner process not alive) are reclaimed.
   */
  private async _reconcileInflight(): Promise<void> {
    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(this.inflightDir, { includeDirs: false });
    } catch (err) {
      if (isFileNotFound(err)) return;
      const reason = formatErr(err);
      emitInboxListFailed(this.audit, {
        dir: this.inflightDir,
        op: 'reconcile',
        errorCode: classifyErrno(err),
        reason,
      });
      return;
    }

    const CLAIM_RE = /^(\d+)_([0-9a-f]+)_(.+\.md)$/i;
    const STALE_THRESHOLD_MS = 5 * 60 * 1000;
    let revertedCount = 0;

    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;

      let originalName: string;
      let shouldReclaim = false;
      const match = entry.name.match(CLAIM_RE);
      if (!match) {
        // Legacy format (pre-Phase 930): no PID lease, use mtime-based heuristic.
        originalName = entry.name;
        const sourcePath = path.join(this.inflightDir, entry.name);
        let mtime: number;
        try {
          const stat = await this.fs.stat(sourcePath);
          mtime = stat.mtime.getTime();
        } catch (err) {
          emitInboxMoveFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_stat',
            errorCode: classifyErrno(err),
            reason: formatErr(err),
          });
          continue;
        }
        if (Date.now() - mtime >= STALE_THRESHOLD_MS) {
          shouldReclaim = true;
        }
      } else {
        const pid = parseInt(match[1], 10);
        const startTimeHex = match[2];
        originalName = match[3];
        if (startTimeHex !== '0') {
          const startTime = makeProcessStartTime(Buffer.from(startTimeHex, 'hex').toString('utf8'));
          if (!isAlive(pid, startTime)) {
            shouldReclaim = true;
          }
        } else {
          // No startTime recorded (legacy claim or fallback) — use mtime lease.
          // If the inflight file is older than STALE_THRESHOLD_MS, assume the claimant is dead.
          const sourcePath = path.join(this.inflightDir, entry.name);
          try {
            const stat = await this.fs.stat(sourcePath);
            if (Date.now() - stat.mtime.getTime() >= STALE_THRESHOLD_MS) {
              shouldReclaim = true;
            }
          } catch (statErr) {
            if (!isFileNotFound(statErr)) throw statErr;
            // File vanished — reclaim is safe (nothing to move, will fail silently below).
            shouldReclaim = true;
          }
        }
      }

      if (!shouldReclaim) continue;

      const sourcePath = path.join(this.inflightDir, entry.name);
      const targetPath = path.join(this.pendingDir, originalName);
      try {
        await this.fs.move(sourcePath, targetPath);
        revertedCount++;
      } catch (err) {
        const reason = formatErr(err);
        emitInboxMoveFailed(this.audit, {
          file: entry.name,
          op: 'reconcile_pending',
          errorCode: classifyErrno(err),
          reason,
        });
      }
    }

    if (revertedCount > 0) {
      emitInboxReconcile(this.audit, {
        revertedCount,
        from: 'inflight',
        to: 'pending',
        reason: 'startup_reconcile',
      });
    }
  }

  /**
   * Read all pending messages, sort by priority (desc) then timestamp (asc).
   *
   * Side effects (phase 427 Step C, review N12 — replaces earlier self-contradictory
   * "non-consuming read" claim):
   * - Malformed files are moved to failed/ via markFailed (consumed for that file).
   * - Duplicate-taskId files are moved to done/ via markDone (deduped consumed).
   * - Successful entries remain in pending/ — caller decides via markDone/markFailed.
   *
   * Legacy path; Runtime should prefer drainAndDeliver().
   */
  async drainInbox(): Promise<DrainInboxResult> {
    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(this.pendingDir, { includeDirs: false });
    } catch (err) {
      if (isFileNotFound(err)) return { entries: [], transientErrors: 0, permanentErrors: 0 };
      const reason = formatErr(err);
      emitInboxListFailed(this.audit, {
        dir: this.pendingDir,
        errorCode: classifyErrno(err),
        reason,
      });
      throw new InboxListFailed(this.pendingDir, err);
    }

    let transientErrors = 0;
    let permanentErrors = 0;
    const results: InboxEntry[] = [];
    const seenTaskIds = new Set<string>();
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const filePath = path.join(this.pendingDir, entry.name);
      try {
        let content: string;
        try {
          content = await this.fs.read(filePath);
        } catch (readErr) {
          if (isFileNotFound(readErr)) throw readErr;
          throw new InboxReadError(`I/O error reading inbox file: ${formatErr(readErr)}`, readErr);
        }
        const message = decodeInbox(content);
        if (message.extraMeta?.__original_priority !== undefined) {
          emitInboxPriorityUnknown(this.audit, {
            file: entry.name,
            original: message.extraMeta.__original_priority,
            fallback: message.priority,
          });
        }
        if (message.extraMeta?.__legacy_claw_id !== undefined) {
          emitInboxLegacyClawIdField(this.audit, {
            file: entry.name,
            clawId: makeClawId(message.extraMeta.__legacy_claw_id),
          });
        }

        let shortTaskId: string | undefined;
        let fullTaskId: string | undefined;
        try {
          const parsed = JSON.parse(message.content);
          if (typeof parsed.taskId === 'string') {
            shortTaskId = parsed.taskId;
          }
          if (typeof parsed.fullTaskId === 'string') {
            fullTaskId = parsed.fullTaskId;
          }
        } catch {
          // silent: non-JSON content — skip dedupe
        }

        // phase 849: dedup by shortId (agent-facing); emit both keys for audit.
        const dedupKey = shortTaskId ?? fullTaskId;
        if (dedupKey && seenTaskIds.has(dedupKey)) {
          emitInboxDeduped(this.audit, {
            file: entry.name,
            shortTaskId,
            fullTaskId,
            contractId: message.metadata?.contract_id,
          });
          try {
            await this.markDone(filePath);
          } catch (e) {
            if (!isFileNotFound(e)) {
              // phase 578: 加 file forensic col
              emitInboxMarkDoneFailed(this.audit, { file: entry.name, reason: (e as Error).message });
            }
          }
          continue;
        }
        if (dedupKey) {
          seenTaskIds.add(dedupKey);
        }

        results.push({ message, filePath });
      } catch (err) {
        // Phase 992: InboxReadError (transient read fault) stays in pending for retry.
        // ENOENT or decode/validation errors are permanent and move to failed.
        if (err instanceof InboxReadError) {
          transientErrors++;
          emitInboxFailed(this.audit, {
            file: entry.name,
            errorCode: classifyErrno(err.causeErr),
            reason: `transient IO error — kept in pending: ${formatErr(err)}`,
          });
          continue;
        }
        const reason = formatErr(err);
        emitInboxFailed(this.audit, {
          file: entry.name,
          errorCode: classifyErrno(err),
          reason,
        });
        try {
          await this.markFailed(filePath);
          permanentErrors++;
        } catch (moveErr) {
          throw moveErr;
        }
      }
    }

    results.sort((a, b) => {
      const pa = PRIORITY_VALUES[a.message.priority] ?? PRIORITY_VALUES.normal;
      const pb = PRIORITY_VALUES[b.message.priority] ?? PRIORITY_VALUES.normal;
      if (pa !== pb) return pb - pa;
      const ta = new Date(a.message.timestamp).getTime() || 0;
      const tb = new Date(b.message.timestamp).getTime() || 0;
      return ta - tb;
    });

    return { entries: results, transientErrors, permanentErrors };
  }

  /**
   * Drain pending messages and move them to inflight/ (delivered but not yet acked).
   * Returns both decoded entries and handles for subsequent ack/nack.
   * Crash before ack → init() reconcile moves inflight/ back to pending/.
   */
  async drainAndDeliver(): Promise<{ entries: InboxEntry[]; handles: InboxHandle[]; transientErrors: number; permanentErrors: number }> {
    const { entries, transientErrors, permanentErrors } = await this.drainInbox();
    const handles: InboxHandle[] = [];
    const deliveredEntries: InboxEntry[] = [];

    for (const entry of entries) {
      const fileName = path.basename(entry.filePath);
      const pid = process.pid;
      const startTime = getProcessStartTime(pid);
      const startTimeHex = startTime ? Buffer.from(startTime).toString('hex') : '0';
      const inflightName = `${pid}_${startTimeHex}_${fileName}`;
      const inflightPath = path.join(this.inflightDir, inflightName);
      try {
        await this.fs.move(entry.filePath, inflightPath);
      } catch (err) {
        const reason = formatErr(err);
        emitInboxMoveFailed(this.audit, {
          file: fileName,
          op: 'deliver_inflight',
          errorCode: classifyErrno(err),
          reason,
        });
        // Stop delivering at first move failure; remaining stay in pending/
        break;
      }

      // mtime update is best-effort; failure does not invalidate the delivery
      try {
        const now = new Date();
        await this.fs.utimes(inflightPath, now, now);
      } catch (err) {
        emitInboxMoveFailed(this.audit, {
          file: fileName,
          op: 'deliver_utimes',
          errorCode: classifyErrno(err),
          reason: formatErr(err),
        });
        // Continue — delivery is still valid
      }

      handles.push(this._makeHandle(inflightPath, fileName));
      deliveredEntries.push({ message: entry.message, filePath: inflightPath });
    }

    return { entries: deliveredEntries, handles, transientErrors, permanentErrors };
  }

  /** Acknowledge handle: move from inflight/ to done/ */
  async ack(handle: InboxHandle): Promise<void> {
    const sourcePath = this._validateHandle(handle);
    const fileName = handle.originalFileName;
    const uuid8 = newShortUuid();
    const targetPath = path.join(this.doneDir, `${Date.now()}_${uuid8}_${fileName}`);
    try {
      await this.fs.move(sourcePath, targetPath);
    } catch (err) {
      const reason = formatErr(err);
      emitInboxMoveFailed(this.audit, {
        file: fileName,
        op: 'ack_done',
        errorCode: classifyErrno(err),
        reason,
      });
      throw new InboxMoveFailed(handle.filePath, 'ack_done', err);
    }
    emitInboxDone(this.audit, { file: fileName });
    emitOutboxDelivered(this.audit, { file: fileName });
  }

  /**
   * phase 442 (review N3-C-H1 / R2-C-N1): Move inflight handle to misrouted/
   * for `to=<other_claw>` messages.
   *
   * Preserves the file (vs ack→done/ which conflates with normally-processed
   * messages), giving DP「持久化一切信息」+ DP「事后可审计」a dedicated quarantine
   * sink. Caller (Runtime._drainAndInjectFromInbox unaddressed branch) uses this
   * instead of ack().
   */
  async markMisrouted(handle: InboxHandle): Promise<void> {
    const sourcePath = this._validateHandle(handle);
    const fileName = handle.originalFileName;
    const uuid8 = newShortUuid();
    const targetPath = path.join(this.misroutedDir, `${Date.now()}_${uuid8}_${fileName}`);
    try {
      await this.fs.move(sourcePath, targetPath);
    } catch (err) {
      const reason = formatErr(err);
      emitInboxMoveFailed(this.audit, {
        file: fileName,
        op: 'misrouted',
        errorCode: classifyErrno(err),
        reason,
      });
      throw new InboxMoveFailed(handle.filePath, 'misrouted', err);
    }
    emitInboxMisrouted(this.audit, { file: fileName });
  }

  /** Negative acknowledge: move from inflight/ back to pending/ */
  async nack(handle: InboxHandle, reason?: string): Promise<void> {
    const sourcePath = this._validateHandle(handle);
    const fileName = handle.originalFileName;
    const targetPath = path.join(this.pendingDir, fileName);
    try {
      await this.fs.move(sourcePath, targetPath);
    } catch (err) {
      const errReason = formatErr(err);
      emitInboxMoveFailed(this.audit, {
        file: fileName,
        op: 'nack_pending',
        errorCode: classifyErrno(err),
        reason: errReason,
      });
      throw new InboxMoveFailed(handle.filePath, 'nack_pending', err);
    }
    emitInboxNack(this.audit, { file: fileName, reason });
  }

  /** Move processed file to done/ (legacy helper; ack() preferred) */
  async markDone(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const uuid8 = newShortUuid();
    const targetPath = path.join(this.doneDir, `${Date.now()}_${uuid8}_${fileName}`);
    try {
      await this.fs.move(filePath, targetPath);
    } catch (err) {
      const reason = formatErr(err);
      emitInboxMoveFailed(this.audit, {
        file: fileName,
        op: 'done',
        errorCode: classifyErrno(err),
        reason,
      });
      throw new InboxMoveFailed(filePath, 'done', err);
    }
    emitInboxDone(this.audit, { file: fileName });
    emitOutboxDelivered(this.audit, { file: fileName });
  }

  /**
   * Lightweight pending message count — no file reads, directory list only.
   *
   * Use case: health checks, watchdog, status views that only need "how many pending"
   * without the metadata parse cost of peekMetas().
   *
   * @returns number of .md files in pending/ (0 if dir missing/empty)
   */
  async peekPendingCount(): Promise<number> {
    try {
      const entries = await this.fs.list(this.pendingDir, { includeDirs: false });
      return entries.filter(e => e.name.endsWith('.md')).length;
    } catch (err) {
      if (isFileNotFound(err)) return 0;
      const reason = formatErr(err);
      emitInboxListFailed(this.audit, {
        dir: this.pendingDir,
        op: 'peek_count',
        errorCode: classifyErrno(err),
        reason,
      });
      return 0;
    }
  }

  /**
   * Non-consuming peek of inbox meta entries (no file move, no delete).
   */
  async peekMetas(filter?: { priority?: Priority[] }): Promise<InboxMessageMeta[]> {
    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(this.pendingDir, { includeDirs: false });
    } catch (err) {
      if (isFileNotFound(err)) return [];
      const reason = formatErr(err);
      emitInboxListFailed(this.audit, {
        dir: this.pendingDir,
        op: 'peek',
        errorCode: classifyErrno(err),
        reason,
      });
      return [];
    }

    const results: InboxMessageMeta[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const filePath = path.join(this.pendingDir, entry.name);
      const result = InboxWriter.readMeta(this.fs, filePath);
      if (!result.ok) {
        if (result.error.kind === 'not_found') {
          emitInboxPeekRaceSkip(this.audit, { file: entry.name });
        } else {
          emitInboxMetaFailed(this.audit, { file: entry.name, kind: result.error.kind });
        }
        continue;
      }
      const meta = result.value;
      if (filter?.priority && !filter.priority.includes(meta.priority as Priority)) continue;
      results.push(meta);
    }
    return results;
  }

  /**
   * Find first inbox message whose extraMeta[key] === value.
   *
   * Scope (forward state-machine order):
   * - pending/ (any age)
   * - inflight/ (any age — drained but not yet acked, phase 196)
   * - done/ (mtime within opts.includeDoneWithinMs)
   *
   * `failed/` is NOT scanned by-design: failed inbox handling should let caller
   * (e.g. outbox-summary cron dedup) re-emit, not be suppressed by dedup.
   *
   * Returns first hit (no need to enumerate all).
   *
   * Use case: dedup query — caller wants to check "is there already a delivered/pending/
   * inflight message with this hash within 24h?" before writing a new one.
   *
   * Performance: parses every candidate file's meta (no index). For high-frequency
   * queries, caller should cache result or this method should grow a hash index sidecar.
   *
   * 扫描 inbox 状态机正向 3 态（pending → inflight → done within window）。
   * `failed/` 不扫为显式语义决策：失败的 inbox 处理应让 caller（如 outbox-summary
   * cron dedup）re-emit、不该 dedup 屏蔽。该决策编入下方 switch `case 'failed'`
   * 语言层面、未来作者无需重新推导。
   *
   * 状态空间扩态时（如未来加 'archived'）：
   *   1. INBOX_LOCATIONS 加 literal → InboxLocation type 自动扩
   *   2. 本函数 switch 必报 TS error（assertNever default 不再 unreachable）
   *   3. 作者被强制处理新态的扫描/不扫语义决策
   *
   * @returns null if no hit, else { file: <basename>, location: ScannedInboxLocation }
   */
  async findByExtraMeta(
    key: string,
    value: string,
    opts: { includeDoneWithinMs?: number } = {},
  ): Promise<{ file: string; location: ScannedInboxLocation } | null> {
    for (const location of INBOX_LOCATIONS) {
      const hit = await this._tryScanLocation(location, key, value, opts);
      if (hit) return hit;
    }
    return null;
  }

  private async _tryScanLocation(
    location: InboxLocation,
    key: string,
    value: string,
    opts: { includeDoneWithinMs?: number },
  ): Promise<{ file: string; location: ScannedInboxLocation } | null> {
    switch (location) {
      case 'pending': {
        const file = await this._scanByExtraMeta(this.pendingDir, key, value, undefined);
        return file ? { file, location: 'pending' } : null;
      }
      case 'inflight': {
        // phase 196: 扫 inflight 修 outbox-summary cron tick 在 motion drain→ack 窗口
        // 的 dedup miss、无 mtime 窗口（inflight 本应短暂态、文件不该长期驻留）。
        const file = await this._scanByExtraMeta(this.inflightDir, key, value, undefined);
        return file ? { file, location: 'inflight' } : null;
      }
      case 'done': {
        const windowMs = opts.includeDoneWithinMs ?? 0;
        if (windowMs <= 0) return null;
        const cutoff = Date.now() - windowMs;
        const file = await this._scanByExtraMeta(this.doneDir, key, value, cutoff);
        return file ? { file, location: 'done' } : null;
      }
      case 'failed':
        // 显式语义决策：failed/ 不扫、让 caller re-emit。本 case 不可改为扫描、
        // 否则 dedup 会屏蔽失败的通知、违反「失败需重新通知」契约。
        return null;
      default: {
        const _exhaustive: never = location;
        return _exhaustive;
      }
    }
  }

  private async _scanByExtraMeta(
    dir: string,
    key: string,
    value: string,
    mtimeCutoff: number | undefined,
  ): Promise<string | null> {
    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(dir, { includeDirs: false });
    } catch (err) {
      if (isFileNotFound(err)) return null;
      throw err; // EACCES/EIO → propagate — caller must not assume "no duplicate"
    }

    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const filePath = path.join(dir, entry.name);

      if (mtimeCutoff !== undefined) {
        try {
          const s = await this.fs.stat(filePath);
          if (s.mtime.getTime() < mtimeCutoff) continue;
        } catch (statErr) {
          if (isFileNotFound(statErr)) continue; // TOCTOU
          throw statErr; // real I/O error → propagate
        }
      }

      const result = InboxWriter.readMeta(this.fs, filePath);
      if (!result.ok) {
        // TOCTOU: file vanished between list and read → skip
        if (result.error.kind === 'not_found') continue;
        // Real error: permission, I/O, parse → propagate. Can't give a definitive "no duplicate".
        throw new Error(`Dedup scan failed reading ${filePath}: ${result.error.kind}`);
      }
      const meta = result.value;
      if (meta[key] === value) return entry.name;
    }
    return null;
  }

  /** Move failed file to failed/ (legacy helper) */
  async markFailed(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const uuid8 = newShortUuid();
    const targetPath = path.join(this.failedDir, `${Date.now()}_${uuid8}_${fileName}`);
    try {
      await this.fs.move(filePath, targetPath);
    } catch (err) {
      const reason = formatErr(err);
      emitInboxMoveFailed(this.audit, {
        file: fileName,
        op: 'failed',
        errorCode: classifyErrno(err),
        reason,
      });
      throw new InboxMoveFailed(filePath, 'failed', err);
    }
  }
}
