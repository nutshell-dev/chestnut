/**
 * OutboxReader - 单 claw outbox 读侧 + 列举
 *
 * 业主：Messaging 模块拥 outbox 资源（per architecture.md 表 1）。
 * 外部模块（如 outbox-summary）需要 outbox 状态查询时通过本 class、不直接 fs.list。
 *
 * 当前 scope：只列 pending（outbox 未消费消息）。done/failed/inflight 暂不暴露读接口、
 * caller 按需扩展。
 *
 * phase 42 NEW（前置：outbox-summary 重构、消除 MLP-3 违反）。
 */

import * as path from 'path';
import { formatErr } from '../node-utils/index.js';
import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';
import { getProcessStartTime } from '../process-exec/index.js';
import type { MessagingAuditSink } from './audit-sink.js';
import {
  emitOutboxClaimFailed,
  emitOutboxDelivered,
  emitOutboxListFailed,
  emitOutboxPeekFailed,
  emitOutboxProcessingOrphanCleaned,
  emitOutboxReconcile,
  emitOutboxSkipped,
  emitOutboxStageQuarantine,
} from './audit-emit.js';
import { decodeOutbox } from './codec-outbox.js';
import type { OutboxMessage } from './types.js';
import { OutboxMoveFailed } from './errors.js';
import {
  OUTBOX_PENDING_DIR,
  OUTBOX_PROCESSING_DIR,
  OUTBOX_DONE_DIR,
  OUTBOX_FAILED_DIR,
} from './dirs.js';
import { newShortUuid } from '../node-utils/index.js';
import { observeLegacyClaim } from './claim-process-observation.js';
import {
  ClaimObservationStore,
  type ClaimDecision,
  type ClaimLease,
} from './claim-observation-store.js';

type ClaimResult =
  | { status: 'empty' }
  | { status: 'race_lost'; error: string }
  | { status: 'io_error'; error: string }
  | { status: 'recovery_required'; readError: string; rollbackError: string; claimPath: string; filename: string }
  | { status: 'claimed'; claimPath: string; filename: string; content: string };

/**
 * Phase 1784: typed outbox peek outcome.
 *
 * peek 必须区分真正 empty 与 list/read/decode failure，不得以 null 压平系统故障：
 * - `empty`：pending 空或目录缺失（合法空态）。
 * - `found`：最新 pending entry（filename 字典序 == 时间序）。
 * - `failed`：list/read/decode 首个失败，携带 stage、path（list 阶段为 pending
 *   dir）与原始 error；caller 必须显式处理（如 failed_claws + incomplete），不得
 *   当空队列降级展示。
 */
export type OutboxPeekResult =
  | { kind: 'empty' }
  | { kind: 'found'; filename: string; message: OutboxMessage }
  | { kind: 'failed'; stage: 'list' | 'read' | 'decode'; path: string; error: unknown };

export class OutboxReader {
  constructor(
    private readonly fs: FileSystem,
    private readonly audit: MessagingAuditSink,
  ) {}

  /**
   * Ensure outbox directories exist + reconcile orphaned processing files back to pending.
   */
  async init(clawDir: string): Promise<void> {
    await this.fs.ensureDir(path.join(clawDir, OUTBOX_PENDING_DIR));
    await this.fs.ensureDir(path.join(clawDir, OUTBOX_PROCESSING_DIR));
    await this.fs.ensureDir(path.join(clawDir, OUTBOX_DONE_DIR));
    await this._reconcileProcessing(clawDir);
    await this._recoverStaged(clawDir);
  }

  /**
   * Reconcile orphaned processing files back to pending on startup.
   * Guarantees crash recovery: a claimed message that was not marked done/failed
   * will eventually be re-delivered.
   */
  private async _reconcileProcessing(clawDir: string): Promise<void> {
    const processingDir = path.join(clawDir, OUTBOX_PROCESSING_DIR);
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    const doneDir = path.join(clawDir, OUTBOX_DONE_DIR);

    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(processingDir, { includeDirs: false });
    } catch (err) {
      if (isFileNotFound(err)) return;
      emitOutboxListFailed(this.audit, {
        dir: processingDir,
        reason: formatErr(err),
      });
      return;
    }

    // pending 列目录失败仍中止 reconcile（保留 audit）；快照不再用于分流决策
    //（Stage 2 O_EXCL 取代 exists 判断）。
    try {
      await this.fs.list(pendingDir, { includeDirs: false });
    } catch (err) {
      emitOutboxListFailed(this.audit, {
        dir: pendingDir,
        op: 'reconcile',
        reason: formatErr(err),
      });
      return;
    }

    let revertedCount = 0;
    let observationStore: ClaimObservationStore | undefined;
    const getObservationStore = (): ClaimObservationStore => {
      observationStore ??= new ClaimObservationStore(this.fs, processingDir);
      return observationStore;
    };

    const CLAIM_TOKEN_RE = /^cli_(\d+)_([0-9a-f]+)_[0-9a-z]+_(.+\.md)$/i;
    const OLD_TOKEN_RE = /^cli_(\d+)_[0-9a-z]+_(.+\.md)$/i;
    const STALE_THRESHOLD_MS = 5 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;

      const newMatch = entry.name.match(CLAIM_TOKEN_RE);
      const oldMatch = !newMatch ? entry.name.match(OLD_TOKEN_RE) : null;
      const originalName = newMatch
        ? newMatch[3]
        : oldMatch
          ? oldMatch[2]
          : entry.name.replace(/^cli_[^_]+_/, '');
      const sourcePath = path.join(processingDir, entry.name);
      let mtime: number;
      try {
        const stat = await this.fs.stat(sourcePath);
        mtime = stat.mtime.getTime();
      } catch (err) {
        emitOutboxClaimFailed(this.audit, {
          file: entry.name,
          op: 'reconcile_stat',
          reason: formatErr(err),
        });
        await getObservationStore().recordDecision({
          rawName: entry.name,
          originalName,
          decision: { kind: 'skip', reason: isFileNotFound(err) ? 'source_absent' : 'stat_failed' },
        }, { originalStatError: err });
        continue;
      }

      const observedAtMs = Date.now();
      const lease: ClaimLease = {
        thresholdMs: STALE_THRESHOLD_MS,
        observedAtMs,
        ...(Number.isFinite(mtime) ? { valueMs: mtime } : { valueMsText: String(mtime) }),
      };
      const leaseElapsed = Number.isFinite(mtime) && observedAtMs - mtime >= STALE_THRESHOLD_MS;
      let decision: ClaimDecision;

      if (!newMatch && !oldMatch) {
        // Legacy format (pre-Phase 908): no PID, use mtime-based heuristic only.
        decision = leaseElapsed
          ? { kind: 'reclaim', reason: 'lease_elapsed' }
          : { kind: 'retain', reason: 'lease_active' };
        await getObservationStore().recordDecision({
          rawName: entry.name,
          originalName,
          lease,
          decision,
        });
      } else {
        const pid = parseInt((newMatch ?? oldMatch)![1], 10);
        const startTimeHex = newMatch?.[2];
        const facts = observeLegacyClaim(
          pid,
          startTimeHex === undefined || startTimeHex === '0'
            ? undefined
            : Buffer.from(startTimeHex, 'hex').toString('utf8'),
        );
        const store = getObservationStore();
        await store.recordObservation({ rawName: entry.name, originalName, process: facts });

        const leaseEligible = oldMatch !== null || startTimeHex === '0';
        if (facts.decoded.kind !== 'decoded') {
          decision = { kind: 'retain', reason: 'invalid_reference' };
        } else if (facts.observed?.kind === 'gone') {
          decision = { kind: 'reclaim', reason: 'process_gone' };
        } else if (leaseEligible && leaseElapsed) {
          decision = { kind: 'reclaim', reason: 'lease_elapsed' };
        } else if (leaseEligible) {
          decision = { kind: 'retain', reason: 'lease_active' };
        } else {
          decision = {
            kind: 'retain',
            reason: facts.observed?.kind === 'alive' ? 'alive' : 'unknown',
          };
        }
        await store.recordDecision({
          rawName: entry.name,
          originalName,
          process: facts,
          lease,
          decision,
        });
      }

      if (decision.kind !== 'reclaim') continue;

      const targetPath = path.join(pendingDir, originalName);
      const failedDir = path.join(clawDir, OUTBOX_FAILED_DIR);

      // Phase 1908 Step G（RACE-OUTBOX-RECONCILE-TARGET）：回收永远不覆盖已有
      // pending —— 禁止 exists 快照后裸 rename（同根 rename 会替换目标）。照
      // InboxReader._restoreToPending 三阶段协议：
      //   Stage 1 — staging 化（唯一名不冲突）；ENOENT = race-lost，不喉非 ENOENT。
      //   Stage 2 — 目标缺失 → O_EXCL 原子占位（快照后出现的 pending 会 EEXIST，
      //             不被覆盖）；占位成功后删 staging。
      //   Stage 3 — 目标存在 → 比完整内容：同 → staging 归档 done/（去重）；
      //             异 → staging 进 failed/ DLQ（冲突，双保留）。
      const stageName = `.tmp_${newShortUuid()}_${originalName}.staging`;
      const stagePath = path.join(pendingDir, stageName);
      try {
        await this.fs.move(sourcePath, stagePath);
      } catch (err) {
        if (isFileNotFound(err)) continue; // race-lost: 已被并发 consumer 处理
        emitOutboxClaimFailed(this.audit, {
          file: entry.name,
          op: 'reconcile_pending',
          reason: formatErr(err),
        });
        continue;
      }

      // staging 出错时尽量搬回 processing，恢复原状等下次 reconcile，不滞留 pending。
      const restoreStage = async (): Promise<void> => {
        try {
          await this.fs.move(stagePath, sourcePath);
        } catch {
          // silent: staging 已不在（并发清理）或搬回失败 —— 残留 .staging 不可 drain，
          // 错误已 audit，下轮启动人工/工具可检。
        }
      };

      let targetContent: string | null = null;
      try {
        targetContent = await this.fs.read(targetPath);
      } catch (err) {
        if (!isFileNotFound(err)) {
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_compare_read',
            reason: formatErr(err),
          });
          await restoreStage();
          continue;
        }
        targetContent = null;
      }

      if (targetContent === null) {
        // Stage 2 — O_EXCL 原子占位
        let stageContent: string;
        try {
          stageContent = await this.fs.read(stagePath);
        } catch (err) {
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_compare_read',
            reason: formatErr(err),
          });
          await restoreStage();
          continue;
        }
        try {
          this.fs.writeExclusiveSync(targetPath, stageContent);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            emitOutboxClaimFailed(this.audit, {
              file: entry.name,
              op: 'reconcile_pending',
              reason: formatErr(err),
            });
            await restoreStage();
            continue;
          }
          // 目标在快照/读取后并发出现 —— 重读进 Stage 3
          try {
            targetContent = await this.fs.read(targetPath);
          } catch (readErr) {
            emitOutboxClaimFailed(this.audit, {
              file: entry.name,
              op: 'reconcile_compare_read',
              reason: formatErr(readErr),
            });
            await restoreStage();
            continue;
          }
        }
        if (targetContent === null) {
          // 占位成功 —— 删 staging，完成回收
          try {
            this.fs.deleteSync(stagePath);
          } catch (err) {
            if (!isFileNotFound(err)) {
              emitOutboxClaimFailed(this.audit, {
                file: entry.name,
                op: 'reconcile_pending',
                reason: formatErr(err),
              });
            }
          }
          revertedCount++;
          continue;
        }
      }

      // Stage 3 — 目标已存在：比完整内容分流
      let stageContent: string;
      try {
        stageContent = await this.fs.read(stagePath);
      } catch (err) {
        emitOutboxClaimFailed(this.audit, {
          file: entry.name,
          op: 'reconcile_compare_read',
          reason: formatErr(err),
        });
        await restoreStage();
        continue;
      }
      if (stageContent === targetContent) {
        // 同内容 → 已被其他 consumer 重投递；归档 staging 副本（去重）
        try {
          await this.fs.move(stagePath, path.join(doneDir, entry.name));
        } catch (err) {
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_archive',
            reason: formatErr(err),
          });
        }
      } else {
        // 异内容 → 冲突，staging 副本进 DLQ（双保留）
        try {
          await this.fs.ensureDir(failedDir);
          await this.fs.move(stagePath, path.join(failedDir, entry.name));
        } catch (err) {
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_dlq',
            reason: formatErr(err),
          });
        }
      }
    }

    if (revertedCount > 0) {
      emitOutboxProcessingOrphanCleaned(this.audit, { count: revertedCount });
    }
  }

  /**
   * Recover crash-leftover pending/.tmp_*.staging files after processing reconcile.
   * The pending target is published only with O_EXCL; existing targets are never overwritten.
   */
  private async _recoverStaged(clawDir: string): Promise<void> {
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    const failedDir = path.join(clawDir, OUTBOX_FAILED_DIR);
    const STAGE_RE = /^\.tmp_[a-f0-9]{8}_(.+\.md)\.staging$/i;

    let entries: { name: string }[];
    try {
      entries = await this.fs.list(pendingDir, { includeDirs: false });
    } catch (err) {
      if (isFileNotFound(err)) return;
      emitOutboxListFailed(this.audit, {
        dir: pendingDir,
        op: 'recover_stage',
        reason: formatErr(err),
      });
      return;
    }

    let revertedCount = 0;
    for (const entry of entries) {
      if (!entry.name.endsWith('.staging')) continue;
      const match = entry.name.match(STAGE_RE);
      const stagePath = path.join(pendingDir, entry.name);
      if (!match) {
        const quarantinePath = path.join(
          failedDir,
          `${Date.now()}_${newShortUuid()}_quarantine_staging_${entry.name}`,
        );
        try {
          await this.fs.ensureDir(failedDir);
          await this.fs.move(stagePath, quarantinePath);
        } catch (err) {
          if (isFileNotFound(err)) continue;
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'recover_stage_quarantine',
            reason: formatErr(err),
          });
          continue;
        }
        emitOutboxStageQuarantine(this.audit, {
          file: entry.name,
          reason: 'unparseable_staging_format',
        });
        continue;
      }

      try {
        const result = await this._resolveStagedFile(
          clawDir,
          entry.name,
          match[1],
          'startup_stage_recover',
        );
        if (result === 'restored') revertedCount++;
      } catch (err) {
        if (isFileNotFound(err)) continue;
        emitOutboxClaimFailed(this.audit, {
          file: entry.name,
          op: 'recover_stage',
          reason: formatErr(err),
        });
      }
    }

    if (revertedCount > 0) {
      emitOutboxReconcile(this.audit, {
        revertedCount,
        from: 'stage',
        to: 'pending',
        reason: 'startup_stage_recover',
      });
    }
  }

  /** Resolve one staged pending file without replacing an existing target. */
  private async _resolveStagedFile(
    clawDir: string,
    stageName: string,
    originalName: string,
    recoveryReason: 'startup_stage_recover' | 'claim_rollback',
  ): Promise<'restored' | 'deduped' | 'conflict'> {
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    const stagePath = path.join(pendingDir, stageName);
    const targetPath = path.join(pendingDir, originalName);
    const stageContent = await this.fs.read(stagePath);

    const deleteStage = (): void => {
      try {
        this.fs.deleteSync(stagePath);
      } catch (err) {
        if (!isFileNotFound(err)) throw err;
      }
    };

    let targetContent: string | null = null;
    try {
      targetContent = await this.fs.read(targetPath);
    } catch (err) {
      if (!isFileNotFound(err)) throw err;
    }

    if (targetContent === null) {
      try {
        this.fs.writeExclusiveSync(targetPath, stageContent);
        deleteStage();
        return 'restored';
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          targetContent = await this.fs.read(targetPath);
        } catch (readErr) {
          if (!isFileNotFound(readErr)) throw readErr;
          // The target vanished between EEXIST and re-read; retry the exclusive publish once.
          this.fs.writeExclusiveSync(targetPath, stageContent);
          deleteStage();
          return 'restored';
        }
      }
    }

    if (stageContent === targetContent) {
      const doneDir = path.join(clawDir, OUTBOX_DONE_DIR);
      await this.fs.ensureDir(doneDir);
      await this.fs.move(
        stagePath,
        path.join(doneDir, `${Date.now()}_${newShortUuid()}_${originalName}`),
      );
      emitOutboxReconcile(this.audit, {
        revertedCount: 0,
        from: 'stage',
        to: 'done',
        reason: `${recoveryReason}_dedupe`,
      });
      return 'deduped';
    }

    const failedDir = path.join(clawDir, OUTBOX_FAILED_DIR);
    await this.fs.ensureDir(failedDir);
    await this.fs.move(
      stagePath,
      path.join(failedDir, `${Date.now()}_${newShortUuid()}_${originalName}`),
    );
    emitOutboxStageQuarantine(this.audit, {
      file: originalName,
      reason: 'conflict',
    });
    return 'conflict';
  }

  /** Roll a claimed file back through staging so an existing pending file is never replaced. */
  private async _restoreClaimToPending(
    clawDir: string,
    claimPath: string,
    fileName: string,
  ): Promise<'restored' | 'deduped' | 'conflict'> {
    const stageName = `.tmp_${newShortUuid()}_${fileName}.staging`;
    const stagePath = path.join(clawDir, OUTBOX_PENDING_DIR, stageName);
    await this.fs.move(claimPath, stagePath);
    return this._resolveStagedFile(clawDir, stageName, fileName, 'claim_rollback');
  }

  /**
   * List `.md` filenames in `<clawDir>/outbox/pending`.
   *
   * Use case: aggregator queries (outbox-summary unread count) 不该自己 fs.list outbox。
   *
   * @param clawDir absolute path to a claw root (per string convention)
   * @returns sorted filename array (basename, not absolute path)
   *   - empty array if dir missing / list failed (silent)
   */
  async listClawOutboxPending(clawDir: string): Promise<string[]> {
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    let entries: Awaited<ReturnType<FileSystem['list']>>;
    try {
      entries = await this.fs.list(pendingDir, { includeDirs: false });
    } catch (err) {
      if (isFileNotFound(err)) return [];
      throw err;
    }
    return entries
      .filter(e => e.name.endsWith('.md'))
      .map(e => e.name)
      .sort();
  }

  /**
   * List pending filenames with a discriminated result so callers can distinguish
   * an empty outbox from an I/O failure.
   */
  private async listClawOutboxPendingResult(
    clawDir: string,
  ): Promise<{ ok: true; value: string[] } | { ok: false; error: string }> {
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    try {
      const entries = await this.fs.list(pendingDir, { includeDirs: false });
      return {
        ok: true,
        value: entries
          .filter(e => e.name.endsWith('.md'))
          .map(e => e.name)
          .sort(),
      };
    } catch (err) {
      if (isFileNotFound(err)) return { ok: true, value: [] };
      const reason = formatErr(err);
      emitOutboxListFailed(this.audit, {
        dir: pendingDir,
        reason,
      });
      return { ok: false, error: reason };
    }
  }

  /**
   * Atomically claim the next pending outbox message.
   *
   * Steps:
   *   1. List pending/, take first .md file (filename-sorted)
   *   2. Move pending/<filename> → processing/<claimToken>_<filename> (atomic claim)
   *   3. Read content from claimed path (unless opts.readContent === false)
   *   4. Return { status: 'claimed', claimPath, filename, content }
   *
   * Returns a discriminated result so callers can distinguish:
   *   - `empty`: nothing to claim (including race-lost cases)
   *   - `io_error`: filesystem error while listing/moving/reading; for read failures
   *     this status additionally guarantees the claim was settled through the pending
   *     staging protocol (restored, deduped, or quarantined on conflict)
   *   - `recovery_required`: read failed AND rollback failed — disposition is incomplete
   *     and the file may remain in processing or staging. Carries the original
   *     read error, the rollback error, claimPath and original filename; callers must
   *     surface it explicitly and must not degrade it to empty/io_error. Any rollback
   *     error — including ambiguous ones where the file location is not provably settled
   *     (e.g. transient EIO/timeout or vanished source) — maps here conservatively.
   *
   * The returned `claimPath` is relative to clawDir; caller passes it to markDone()/markFailed()/markSkipped().
   *
   * phase 1748: opts.readContent === false 时跳过 fs.read（outbox-skip 不读内容、
   * rollback 语义只对已读失败保留）；默认行为不变（drain 调用点零改动）。
   *
   * @param clawDir absolute path to a claw root
   * @param opts readContent === false → claim without reading content
   * @returns ClaimResult
   */
  async claimNext(
    clawDir: string,
    opts: { readContent?: boolean } = {},
  ): Promise<ClaimResult> {
    const listResult = await this.listClawOutboxPendingResult(clawDir);
    if (!listResult.ok) return { status: 'io_error', error: listResult.error };
    if (listResult.value.length === 0) return { status: 'empty' };

    const fileName = listResult.value[0]; // oldest first
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    const processingDir = path.join(clawDir, OUTBOX_PROCESSING_DIR);
    const startTime = getProcessStartTime(process.pid);
    const startTimeHex = startTime ? Buffer.from(startTime).toString('hex') : '0';
    const claimToken = `cli_${process.pid}_${startTimeHex}_${newShortUuid()}`;
    const relPendingPath = path.join(pendingDir, fileName);
    const relClaimedPath = path.join(processingDir, `${claimToken}_${fileName}`);

    // Atomic claim
    try {
      await this.fs.move(relPendingPath, relClaimedPath);
    } catch (err) {
      if (isFileNotFound(err)) return { status: 'race_lost', error: 'file already claimed by concurrent consumer' }; // race lost
      // Non-ENOENT: audit the I/O error and return io_error
      const reason = formatErr(err);
      emitOutboxClaimFailed(this.audit, {
        file: fileName,
        op: 'move',
        reason,
      });
      return { status: 'io_error', error: reason };
    }

    // Anchor the fallback lease at claim time, not at the original pending write.
    // The atomic move already established ownership, so utimes failure is audit-only.
    try {
      const now = new Date();
      await this.fs.utimes(relClaimedPath, now, now);
    } catch (err) {
      emitOutboxClaimFailed(this.audit, {
        file: fileName,
        op: 'claim_utimes',
        reason: formatErr(err),
      });
    }

    // Read (phase 1748: skip when opts.readContent === false)
    let content = '';
    if (opts.readContent !== false) {
      try {
        content = await this.fs.read(relClaimedPath);
      } catch (err) {
        const reason = formatErr(err);
        emitOutboxClaimFailed(this.audit, {
          file: fileName,
          op: 'read',
          reason,
        });
        // Roll back through the same no-overwrite staging protocol as startup recovery.
        try {
          await this._restoreClaimToPending(clawDir, relClaimedPath, fileName);
        } catch (rollbackErr) {
          // Rollback failed (or outcome undecidable): the file stays in processing
          // and disposition is incomplete. Return recovery_required carrying both
          // errors + claim identity; do NOT delete the file — restart reconcile
          // (or manual recovery) handles it, and the caller learns about it now.
          const rollbackReason = formatErr(rollbackErr);
          emitOutboxClaimFailed(this.audit, {
            file: fileName,
            op: 'read_rollback',
            reason: rollbackReason,
          });
          return {
            status: 'recovery_required',
            readError: reason,
            rollbackError: rollbackReason,
            claimPath: path.join(OUTBOX_PROCESSING_DIR, `${claimToken}_${fileName}`),
            filename: fileName,
          };
        }
        return { status: 'io_error', error: reason };
      }
    }

    // Build claimPath relative to clawDir (for markDone/markSkipped to use)
    const claimPath = path.join(OUTBOX_PROCESSING_DIR, `${claimToken}_${fileName}`);

    return { status: 'claimed', claimPath, filename: fileName, content };
  }

  private async archiveClaim(
    clawDir: string,
    claimPath: string,
    originalFilename: string,
    kind: 'done' | 'skipped',
  ): Promise<void> {
    const normalizedClaimPath = path.normalize(claimPath);
    const processingPrefix = path.join(OUTBOX_PROCESSING_DIR) + path.sep;
    if (
      normalizedClaimPath === '..' ||
      normalizedClaimPath.startsWith('..' + path.sep) ||
      normalizedClaimPath.startsWith('../') ||
      !normalizedClaimPath.startsWith(processingPrefix)
    ) {
      throw new Error(`Path traversal detected in claimPath: "${claimPath}"`);
    }

    const safeOriginal = path.basename(originalFilename);
    if (!safeOriginal.endsWith('.md') || safeOriginal.includes('..')) {
      throw new Error(`Invalid originalFilename: "${originalFilename}"`);
    }

    const processingFullPath = path.join(clawDir, normalizedClaimPath);
    const doneDir = path.join(clawDir, OUTBOX_DONE_DIR);
    await this.fs.ensureDir(doneDir);
    const donePath = path.join(doneDir, `${Date.now()}_${safeOriginal}`);
    try {
      await this.fs.move(processingFullPath, donePath);
    } catch (err) {
      emitOutboxClaimFailed(this.audit, {
        file: originalFilename,
        op: kind,
        reason: formatErr(err),
      });
      throw new OutboxMoveFailed(processingFullPath, kind, err);
    }

    if (kind === 'done') {
      emitOutboxDelivered(this.audit, { file: originalFilename, deliveredAt: Date.now() });
    } else {
      emitOutboxSkipped(this.audit, { file: originalFilename, skippedAt: Date.now() });
    }
  }

  /**
   * Mark a claimed outbox message as done — move processing/ → done/.
   *
   * @param clawDir absolute path to a claw root
   * @param claimPath relative path within clawDir (returned by claimNext)
   * @param originalFilename original pending filename (for audit trail)
   */
  async markDone(clawDir: string, claimPath: string, originalFilename: string): Promise<void> {
    await this.archiveClaim(clawDir, claimPath, originalFilename, 'done');
  }

  /**
   * Mark a claimed outbox message as skipped — move processing/ → done/ WITHOUT
   * emitting delivered (phase 1748 outbox-skip).
   *
   * Path traversal 校验与 markDone 完全一致；归档目标同 done/<ts>_<origName>.md。
   * 独立 audit 事件 outbox_skipped（不误报 delivered，区别于 markDone）。
   *
   * @param clawDir absolute path to a claw root
   * @param claimPath relative path within clawDir (returned by claimNext)
   * @param originalFilename original pending filename (for audit trail)
   */
  async markSkipped(clawDir: string, claimPath: string, originalFilename: string): Promise<void> {
    await this.archiveClaim(clawDir, claimPath, originalFilename, 'skipped');
  }

  /**
   * Read the **latest** message from `<clawDir>/outbox/pending` (last by filename sort order).
   *
   * Outbox filenames follow `{timestamp}_{type}_{messageUuid}.md` — lexical sort == time sort asc,
   * so the last element is the newest.
   *
   * Pure read: no file move/delete side effect.
   *
   * Use case: outbox-summary motion notification — show preview of each claw's latest
   * unread message.
   *
   * Phase 1784: typed outcome — 真正 empty（pending 空 / 目录缺失）与 list/read/decode
   * 系统故障必须可区分，不得以 null 压平：
   *  - empty：合法空态，无 audit
   *  - failed：携带 stage/path/原始 error（audit 保留），caller 必须显式处理，
   *    不得当空队列降级展示
   *
   * @param clawDir absolute path to a claw root
   */
  async peekLastOutboxPending(clawDir: string): Promise<OutboxPeekResult> {
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    let filenames: string[];
    try {
      filenames = await this.listClawOutboxPending(clawDir);
    } catch (err) {
      emitOutboxPeekFailed(this.audit, {
        file: pendingDir,
        stage: 'list',
        reason: formatErr(err),
      });
      return { kind: 'failed', stage: 'list', path: pendingDir, error: err };
    }
    if (filenames.length === 0) return { kind: 'empty' };
    const latest = filenames[filenames.length - 1];
    const filePath = path.join(pendingDir, latest);
    let raw: string;
    try {
      raw = await this.fs.read(filePath);
    } catch (err) {
      emitOutboxPeekFailed(this.audit, {
        file: filePath,
        stage: 'read',
        reason: formatErr(err),
      });
      return { kind: 'failed', stage: 'read', path: filePath, error: err };
    }
    let message: OutboxMessage;
    try {
      message = decodeOutbox(raw);
    } catch (err) {
      emitOutboxPeekFailed(this.audit, {
        file: filePath,
        stage: 'decode',
        reason: formatErr(err),
      });
      return { kind: 'failed', stage: 'decode', path: filePath, error: err };
    }
    return { kind: 'found', filename: latest, message };
  }
}
