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
import { decodeProcessRef, inspectProcessRef } from '../process-exec/index.js';
import type { MessagingAuditSink } from './audit-sink.js';
import {
  emitOutboxClaimFailed,
  emitOutboxDelivered,
  emitOutboxFailed,
  emitOutboxInitDegraded,
  emitOutboxListFailed,
  emitOutboxPeekFailed,
  emitOutboxProcessingOrphanCleaned,
  emitOutboxReconcile,
  emitOutboxSkipped,
  emitOutboxSettlementFailed,
  emitOutboxStageQuarantine,
} from './audit-emit.js';
import { decodeOutbox } from './codec-outbox.js';
import type {
  OutboxClaimHandle,
  OutboxInitResult,
  OutboxListResult,
  OutboxMessage,
} from './types.js';
import {
  OutboxClaimBindingError,
  OutboxMoveFailed,
  OutboxSettlementRequired,
} from './errors.js';
import {
  OUTBOX_PENDING_DIR,
  OUTBOX_PROCESSING_DIR,
  OUTBOX_DONE_DIR,
  OUTBOX_FAILED_DIR,
} from './dirs.js';
import { newShortUuid } from '../node-utils/index.js';
import { observeLegacyClaim } from './claim-process-observation.js';
import {
  ClaimObservationPersistenceError,
  ClaimObservationStore,
  type ClaimDecision,
  type ClaimLease,
} from './claim-observation-store.js';
import {
  ClaimRecordUnavailableError,
  loadClaimDescriptor,
  type ClaimRecordEvidence,
} from './claim-record.js';
import { prepareClaimRecord } from './claim-record-store.js';
import { recordRecoveryIo } from './recovery-io-evidence.js';

type ClaimResult =
  | { status: 'empty' }
  | { status: 'race_lost'; error: string }
  | { status: 'io_error'; error: string }
  | {
      status: 'recovery_required';
      readError: string;
      rollbackError: string;
      claimPath: string;
      filename: string;
      handle: OutboxClaimHandle;
    }
  | (OutboxClaimHandle & { status: 'claimed'; content: string });

interface RecoveryProgress {
  recovered: number;
}

class OutboxInitError extends Error {
  constructor(
    public readonly stage: 'ensure_dir' | 'list' | 'read' | 'move',
    public readonly path: string,
    public readonly error: unknown,
  ) {
    super(`Outbox init ${stage} failed at ${path}`);
  }
}

export interface OutboxReaderOptions {
  clawRoot: string;
  fs: FileSystem;
  audit: MessagingAuditSink;
}

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
  readonly clawRoot: string;
  private readonly fs: FileSystem;
  private readonly audit: MessagingAuditSink;
  private readonly mintedClaims = new WeakSet<OutboxClaimHandle>();
  private readonly claimSettlements = new WeakMap<OutboxClaimHandle, 'settling' | 'settled'>();
  private readonly failedTargets = new WeakMap<OutboxClaimHandle, { message: string; reason: string }>();

  constructor(options: OutboxReaderOptions) {
    this.clawRoot = options.clawRoot;
    this.fs = options.fs;
    this.audit = options.audit;
  }

  /**
   * Ensure outbox directories exist + reconcile orphaned processing files back to pending.
   * Every ensure/list/read/move failure is returned to the caller as degraded.
   */
  async init(): Promise<OutboxInitResult> {
    const progress: RecoveryProgress = { recovered: 0 };
    try {
      for (const dir of [OUTBOX_PENDING_DIR, OUTBOX_PROCESSING_DIR, OUTBOX_DONE_DIR]) {
        const fullPath = path.join(this.clawRoot, dir);
        try {
          await this.fs.ensureDir(fullPath);
        } catch (error) {
          emitOutboxClaimFailed(this.audit, {
            file: fullPath,
            op: 'init_ensure_dir',
            reason: formatErr(error),
          });
          throw new OutboxInitError('ensure_dir', fullPath, error);
        }
      }
      await this._reconcileProcessing(this.clawRoot, progress);
      await this._recoverStaged(this.clawRoot, progress);
      return { kind: 'ready', recovered: progress.recovered };
    } catch (error) {
      if (error instanceof OutboxInitError) {
        emitOutboxInitDegraded(this.audit, {
          stage: error.stage,
          path: error.path,
          reason: formatErr(error.error),
          recovered: progress.recovered,
        });
        return {
          kind: 'degraded',
          stage: error.stage,
          path: error.path,
          error: error.error,
          recovered: progress.recovered,
        };
      }
      throw error;
    }
  }

  /**
   * Reconcile orphaned processing files back to pending on startup.
   * Guarantees crash recovery: a claimed message that was not marked done/failed
   * will eventually be re-delivered.
   */
  private async _reconcileProcessing(
    clawDir: string,
    progress: RecoveryProgress,
  ): Promise<void> {
    const processingDir = path.join(clawDir, OUTBOX_PROCESSING_DIR);
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    const doneDir = path.join(clawDir, OUTBOX_DONE_DIR);

    let observationStore: ClaimObservationStore | undefined;
    const getObservationStore = (): ClaimObservationStore => {
      observationStore ??= new ClaimObservationStore(this.fs, processingDir);
      return observationStore;
    };

    let entries: { name: string }[] = [];
    try {
      entries = await this.fs.list(processingDir, { includeDirs: false });
    } catch (err) {
      if (isFileNotFound(err)) {
        entries = [];
      } else {
        emitOutboxListFailed(this.audit, {
          dir: processingDir,
          reason: formatErr(err),
        });
        await recordRecoveryIo(getObservationStore(), this.audit, {
          operation: 'list', stage: 'list', path: processingDir, error: err,
        });
        throw new OutboxInitError('list', processingDir, err);
      }
    }

    // pending 列目录失败仍中止 reconcile（保留 audit）；快照不再用于分流决策
    //（Stage 2 O_EXCL 取代 exists 判断）。
    try {
      await this.fs.list(pendingDir, { includeDirs: false });
    } catch (err) {
      if (isFileNotFound(err)) {
        // A missing pending directory is an empty recovery target, not an I/O failure.
      } else {
        emitOutboxListFailed(this.audit, {
          dir: pendingDir,
          op: 'reconcile',
          reason: formatErr(err),
        });
        await recordRecoveryIo(new ClaimObservationStore(this.fs, pendingDir), this.audit, {
          operation: 'list', stage: 'list', path: pendingDir, error: err,
        });
        throw new OutboxInitError('list', pendingDir, err);
      }
    }

    let revertedCount = 0;

    const CLAIM_TOKEN_RE = /^cli_(\d+)_([0-9a-f]+)_[0-9a-z]+_(.+\.md)$/i;
    const OLD_TOKEN_RE = /^cli_(\d+)_[0-9a-z]+_(.+\.md)$/i;
    const STALE_THRESHOLD_MS = 5 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;

      const reservedClaim = entry.name.startsWith('mclaim_');
      const newMatch = reservedClaim ? null : entry.name.match(CLAIM_TOKEN_RE);
      const oldMatch = !reservedClaim && !newMatch ? entry.name.match(OLD_TOKEN_RE) : null;
      let originalName = newMatch
        ? newMatch[3]
        : oldMatch
          ? oldMatch[2]
          : entry.name.replace(/^cli_[^_]+_/, '');
      let claim: ClaimRecordEvidence | undefined;
      let loaded: Awaited<ReturnType<typeof loadClaimDescriptor>> | undefined;
      if (reservedClaim) {
        try {
          loaded = await loadClaimDescriptor(this.fs, processingDir, entry.name, 'outbox');
        } catch (error) {
          if (!(error instanceof ClaimRecordUnavailableError)) throw error;
          claim = {
            ...(error.recordPath !== undefined && { recordPath: error.recordPath }),
            ...(error.raw !== undefined && { raw: error.raw }),
            issue: error.issue,
          };
          const recoveryPath = error.recordPath ?? path.join(processingDir, entry.name);
          const recoveryError = error.cause ?? error;
          if (error.issue.kind === 'io') {
            await recordRecoveryIo(getObservationStore(), this.audit, {
              operation: 'read',
              stage: 'read',
              path: recoveryPath,
              error: recoveryError,
              rawName: entry.name,
              originalName: entry.name,
            });
          }
          await getObservationStore().recordObservation({
            rawName: entry.name,
            originalName: entry.name,
            claim,
          }, { originalClaimReadError: recoveryError });
          throw new OutboxInitError('read', recoveryPath, error);
        }
        originalName = loaded.descriptor.originalName;
        claim = { recordPath: loaded.recordPath, raw: loaded.raw };
      }
      const sourcePath = path.join(processingDir, entry.name);
      let mtime: number;
      try {
        const stat = await this.fs.stat(sourcePath);
        mtime = stat.mtime.getTime();
      } catch (err) {
        if (!isFileNotFound(err)) {
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_stat',
            reason: formatErr(err),
          });
          await recordRecoveryIo(getObservationStore(), this.audit, {
            operation: 'stat',
            stage: 'read',
            path: sourcePath,
            error: err,
            rawName: entry.name,
            originalName,
          });
        }
        await getObservationStore().recordDecision({
          rawName: entry.name,
          originalName,
          ...(claim !== undefined && { claim }),
          decision: { kind: 'skip', reason: isFileNotFound(err) ? 'source_absent' : 'stat_failed' },
        }, { originalStatError: err });
        if (isFileNotFound(err)) continue;
        throw new OutboxInitError('read', sourcePath, err);
      }

      const observedAtMs = Date.now();
      const lease: ClaimLease = {
        thresholdMs: STALE_THRESHOLD_MS,
        observedAtMs,
        ...(Number.isFinite(mtime) ? { valueMs: mtime } : { valueMsText: String(mtime) }),
      };
      const leaseElapsed = Number.isFinite(mtime) && observedAtMs - mtime >= STALE_THRESHOLD_MS;
      let decision: ClaimDecision;

      if (loaded !== undefined && claim !== undefined) {
        const capture = loaded.descriptor.capture;
        const store = getObservationStore();
        if (capture.kind === 'captured') {
          const decoded = decodeProcessRef(capture.value);
          const facts = {
            decoded,
            ...(decoded.kind === 'decoded' && { observed: inspectProcessRef(decoded.value) }),
          };
          await store.recordObservation({
            rawName: entry.name,
            originalName,
            process: facts,
            claim,
          });
          if (decoded.kind !== 'decoded') {
            decision = { kind: 'retain', reason: 'invalid_reference' };
          } else if (facts.observed?.kind === 'gone') {
            decision = { kind: 'reclaim', reason: 'process_gone' };
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
            claim,
            lease,
            decision,
          });
          if (decoded.kind !== 'decoded') {
            const error = new ClaimRecordUnavailableError(entry.name, {
              kind: decoded.kind === 'unsupported_version' ? 'unsupported' : 'invalid',
              detail: decoded.kind === 'invalid'
                ? `process reference is invalid: ${decoded.reason}`
                : 'process reference version is not supported',
            }, { recordPath: loaded.recordPath, raw: loaded.raw });
            throw new OutboxInitError('read', loaded.recordPath, error);
          }
        } else {
          await store.recordObservation({ rawName: entry.name, originalName, claim });
          decision = capture.kind === 'unknown'
            // A failed capture is not a reference-free historical lease.
            ? { kind: 'retain', reason: 'unknown' }
            : leaseElapsed
              ? { kind: 'reclaim', reason: 'lease_elapsed' }
              : { kind: 'retain', reason: 'lease_active' };
          await store.recordDecision({
            rawName: entry.name,
            originalName,
            claim,
            lease,
            decision,
          });
        }
      } else if (!newMatch && !oldMatch) {
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
        } else if (facts.observed?.kind === 'unknown') {
          // Unknown identity never authorizes recovery; an active lease remains
          // useful evidence, while an elapsed lease still cannot reclaim.
          decision = leaseEligible
            ? { kind: 'retain', reason: leaseElapsed ? 'unknown' : 'lease_active' }
            : { kind: 'retain', reason: 'unknown' };
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
      const completedActions: string[] = [];
      try {
        await this.fs.move(sourcePath, stagePath);
      } catch (err) {
        if (isFileNotFound(err)) continue; // race-lost: 已被并发 consumer 处理
        emitOutboxClaimFailed(this.audit, {
          file: entry.name,
          op: 'reconcile_pending',
          reason: formatErr(err),
        });
        await recordRecoveryIo(getObservationStore(), this.audit, {
          operation: 'move',
          stage: 'move',
          path: sourcePath,
          sourcePath,
          targetPath: stagePath,
          completedActions: [...completedActions],
          error: err,
          rawName: entry.name,
          originalName,
        });
        throw new OutboxInitError('move', sourcePath, err);
      }
      completedActions.push('stage');

      // staging 出错时尽量搬回 processing；恢复失败同样是 init degraded。
      const restoreStage = async (): Promise<void> => {
        try {
          await this.fs.move(stagePath, sourcePath);
        } catch (error) {
          if (isFileNotFound(error)) return;
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_restore',
            reason: formatErr(error),
          });
          await recordRecoveryIo(getObservationStore(), this.audit, {
            operation: 'move',
            stage: 'move',
            path: stagePath,
            sourcePath: stagePath,
            targetPath: sourcePath,
            completedActions: [...completedActions],
            error,
            rawName: entry.name,
            originalName,
          });
          throw new OutboxInitError('move', stagePath, error);
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
          await recordRecoveryIo(getObservationStore(), this.audit, {
            operation: 'read',
            stage: 'read',
            path: targetPath,
            sourcePath: stagePath,
            targetPath,
            completedActions: [...completedActions],
            error: err,
            rawName: entry.name,
            originalName,
          });
          await restoreStage();
          throw new OutboxInitError('read', targetPath, err);
        }
        targetContent = null;
      }

      if (targetContent === null) {
        // Stage 2 — O_EXCL 原子占位
        let stageContent: string;
        try {
          stageContent = await this.fs.read(stagePath);
        } catch (err) {
          if (isFileNotFound(err)) continue;
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_compare_read',
            reason: formatErr(err),
          });
          await recordRecoveryIo(getObservationStore(), this.audit, {
            operation: 'read',
            stage: 'read',
            path: stagePath,
            sourcePath: stagePath,
            targetPath,
            completedActions: [...completedActions],
            error: err,
            rawName: entry.name,
            originalName,
          });
          await restoreStage();
          throw new OutboxInitError('read', stagePath, err);
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
            if (!isFileNotFound(err)) {
              await recordRecoveryIo(getObservationStore(), this.audit, {
                operation: 'restore',
                stage: 'move',
                path: targetPath,
                sourcePath: stagePath,
                targetPath,
                completedActions: [...completedActions],
                error: err,
                rawName: entry.name,
                originalName,
              });
            }
            await restoreStage();
            throw new OutboxInitError('move', targetPath, err);
          }
          // 目标在快照/读取后并发出现 —— 重读进 Stage 3
          try {
            targetContent = await this.fs.read(targetPath);
          } catch (readErr) {
            if (isFileNotFound(readErr)) {
              // The target vanished again; leave staging for the next idempotent pass.
              continue;
            } else {
              emitOutboxClaimFailed(this.audit, {
                file: entry.name,
                op: 'reconcile_compare_read',
                reason: formatErr(readErr),
              });
              await recordRecoveryIo(getObservationStore(), this.audit, {
                operation: 'read',
                stage: 'read',
                path: targetPath,
                sourcePath: stagePath,
                targetPath,
                completedActions: [...completedActions],
                error: readErr,
                rawName: entry.name,
                originalName,
              });
              await restoreStage();
              throw new OutboxInitError('read', targetPath, readErr);
            }
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
              await recordRecoveryIo(getObservationStore(), this.audit, {
                operation: 'delete',
                stage: 'move',
                path: stagePath,
                sourcePath: stagePath,
                targetPath,
                completedActions: [...completedActions, 'publish'],
                error: err,
                rawName: entry.name,
                originalName,
              });
              throw new OutboxInitError('move', stagePath, err);
            }
          }
          revertedCount++;
          progress.recovered++;
          continue;
        }
      }

      // Stage 3 — 目标已存在：比完整内容分流
      let stageContent: string;
      try {
        stageContent = await this.fs.read(stagePath);
      } catch (err) {
        if (isFileNotFound(err)) continue;
        emitOutboxClaimFailed(this.audit, {
          file: entry.name,
          op: 'reconcile_compare_read',
          reason: formatErr(err),
        });
        await recordRecoveryIo(getObservationStore(), this.audit, {
          operation: 'read',
          stage: 'read',
          path: stagePath,
          error: err,
          rawName: entry.name,
          originalName,
        });
        await restoreStage();
        throw new OutboxInitError('read', stagePath, err);
      }
      if (stageContent === targetContent) {
        // 同内容 → 已被其他 consumer 重投递；归档 staging 副本（去重）
        try {
          await this.fs.move(stagePath, path.join(doneDir, entry.name));
        } catch (err) {
          if (isFileNotFound(err)) continue;
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_archive',
            reason: formatErr(err),
          });
          await recordRecoveryIo(getObservationStore(), this.audit, {
            operation: 'move',
            stage: 'move',
            path: stagePath,
            sourcePath: stagePath,
            targetPath: path.join(doneDir, entry.name),
            completedActions: [...completedActions],
            error: err,
            rawName: entry.name,
            originalName,
          });
          throw new OutboxInitError('move', stagePath, err);
        }
      } else {
        // 异内容 → 冲突，staging 副本进 DLQ（双保留）
        try {
          await this.fs.ensureDir(failedDir);
        } catch (err) {
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_dlq',
            reason: formatErr(err),
          });
          throw new OutboxInitError('ensure_dir', failedDir, err);
        }
        try {
          await this.fs.move(stagePath, path.join(failedDir, entry.name));
        } catch (err) {
          if (isFileNotFound(err)) continue;
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'reconcile_dlq',
            reason: formatErr(err),
          });
          await recordRecoveryIo(getObservationStore(), this.audit, {
            operation: 'move',
            stage: 'move',
            path: stagePath,
            sourcePath: stagePath,
            targetPath: path.join(failedDir, entry.name),
            completedActions: [...completedActions],
            error: err,
            rawName: entry.name,
            originalName,
          });
          throw new OutboxInitError('move', stagePath, err);
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
  private async _recoverStaged(
    clawDir: string,
    progress: RecoveryProgress,
  ): Promise<void> {
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    const failedDir = path.join(clawDir, OUTBOX_FAILED_DIR);
    const STAGE_RE = /^\.tmp_[a-f0-9]{8}_(.+\.md)\.staging$/i;

    const observationStore = new ClaimObservationStore(this.fs, pendingDir);
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
      await recordRecoveryIo(observationStore, this.audit, {
        operation: 'list', stage: 'list', path: pendingDir, error: err,
      });
      throw new OutboxInitError('list', pendingDir, err);
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
        } catch (err) {
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'recover_stage_quarantine',
            reason: formatErr(err),
          });
          throw new OutboxInitError('ensure_dir', failedDir, err);
        }
        try {
          await this.fs.move(stagePath, quarantinePath);
        } catch (err) {
          if (isFileNotFound(err)) continue;
          emitOutboxClaimFailed(this.audit, {
            file: entry.name,
            op: 'recover_stage_quarantine',
            reason: formatErr(err),
          });
          await recordRecoveryIo(observationStore, this.audit, {
            operation: 'move',
            stage: 'move',
            path: stagePath,
            sourcePath: stagePath,
            targetPath: quarantinePath,
            completedActions: ['stage_existing'],
            error: err,
            rawName: entry.name,
          });
          throw new OutboxInitError('move', stagePath, err);
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
          true,
        );
        if (result === 'restored') {
          revertedCount++;
          progress.recovered++;
        }
      } catch (err) {
        if (isFileNotFound(err)) continue;
        if (err instanceof ClaimObservationPersistenceError) throw err;
        emitOutboxClaimFailed(this.audit, {
          file: entry.name,
          op: 'recover_stage',
          reason: formatErr(err instanceof OutboxInitError ? err.error : err),
        });
        if (err instanceof OutboxInitError) throw err;
        throw new OutboxInitError('read', stagePath, err);
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
    forInit = false,
  ): Promise<'restored' | 'deduped' | 'conflict'> {
    const pendingDir = path.join(clawDir, OUTBOX_PENDING_DIR);
    const stagePath = path.join(pendingDir, stageName);
    const targetPath = path.join(pendingDir, originalName);
    const observationStore = new ClaimObservationStore(this.fs, pendingDir);
    const identity = { rawName: stageName, originalName };
    const completedActions = ['stage_existing'];
    const read = async (filePath: string): Promise<string> => {
      try {
        return await this.fs.read(filePath);
      } catch (error) {
        if (!isFileNotFound(error)) {
          await recordRecoveryIo(observationStore, this.audit, {
            operation: 'read',
            stage: 'read',
            path: filePath,
            sourcePath: filePath,
            targetPath: filePath === targetPath ? stagePath : targetPath,
            completedActions: [...completedActions],
            error,
            ...identity,
          });
          if (forInit) throw new OutboxInitError('read', filePath, error);
        }
        throw error;
      }
    };
    const ensureDir = async (dir: string): Promise<void> => {
      try {
        await this.fs.ensureDir(dir);
      } catch (error) {
        if (forInit) throw new OutboxInitError('ensure_dir', dir, error);
        throw error;
      }
    };
    const move = async (from: string, to: string): Promise<void> => {
      try {
        await this.fs.move(from, to);
      } catch (error) {
        if (!isFileNotFound(error)) {
          await recordRecoveryIo(observationStore, this.audit, {
            operation: 'move',
            stage: 'move',
            path: from,
            sourcePath: from,
            targetPath: to,
            completedActions: [...completedActions],
            error,
            ...identity,
          });
          if (forInit) throw new OutboxInitError('move', from, error);
        }
        throw error;
      }
    };
    const publish = async (): Promise<void> => {
      try {
        this.fs.writeExclusiveSync(targetPath, stageContent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && !isFileNotFound(error)) {
          await recordRecoveryIo(observationStore, this.audit, {
            operation: 'restore',
            stage: 'move',
            path: targetPath,
            sourcePath: stagePath,
            targetPath,
            completedActions: [...completedActions],
            error,
            ...identity,
          });
          if (forInit) throw new OutboxInitError('move', targetPath, error);
        }
        throw error;
      }
    };
    const stageContent = await read(stagePath);

    const deleteStage = async (): Promise<void> => {
      try {
        this.fs.deleteSync(stagePath);
      } catch (err) {
        if (!isFileNotFound(err)) {
          await recordRecoveryIo(observationStore, this.audit, {
            operation: 'delete',
            stage: 'move',
            path: stagePath,
            sourcePath: stagePath,
            targetPath,
            completedActions: [...completedActions],
            error: err,
            ...identity,
          });
          if (forInit) throw new OutboxInitError('move', stagePath, err);
          throw err;
        }
      }
    };

    let targetContent: string | null = null;
    try {
      targetContent = await read(targetPath);
    } catch (err) {
      if (!isFileNotFound(err)) throw err;
    }

    if (targetContent === null) {
      try {
        await publish();
        completedActions.push('publish');
        await deleteStage();
        return 'restored';
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          targetContent = await read(targetPath);
        } catch (readErr) {
          if (!isFileNotFound(readErr)) throw readErr;
          // The target vanished between EEXIST and re-read; retry the exclusive publish once.
          await publish();
          await deleteStage();
          return 'restored';
        }
      }
    }

    if (stageContent === targetContent) {
      const doneDir = path.join(clawDir, OUTBOX_DONE_DIR);
      await ensureDir(doneDir);
      await move(
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
    await ensureDir(failedDir);
    await move(
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
    try {
      await this.fs.move(claimPath, stagePath);
    } catch (error) {
      if (!isFileNotFound(error)) {
        await recordRecoveryIo(new ClaimObservationStore(this.fs, path.dirname(claimPath)), this.audit, {
          operation: 'move',
          stage: 'claim_rollback',
          path: claimPath,
          sourcePath: claimPath,
          targetPath: stagePath,
          completedActions: [],
          error,
          rawName: path.basename(claimPath),
          originalName: fileName,
        });
      }
      throw error;
    }
    return this._resolveStagedFile(clawDir, stageName, fileName, 'claim_rollback');
  }

  /**
   * List pending filenames. ENOENT is a legal empty state; every other list
   * failure retains the original error and audits the exact same reason.
   */
  async listPendingResult(): Promise<OutboxListResult> {
    const pendingDir = path.join(this.clawRoot, OUTBOX_PENDING_DIR);
    try {
      const entries = await this.fs.list(pendingDir, { includeDirs: false });
      const files = entries
        .filter(e => e.name.endsWith('.md'))
        .map(e => e.name)
        .sort();
      return files.length === 0 ? { kind: 'empty', files: [] } : { kind: 'found', files };
    } catch (error) {
      if (isFileNotFound(error)) return { kind: 'empty', files: [] };
      emitOutboxListFailed(this.audit, {
        dir: pendingDir,
        reason: formatErr(error),
      });
      return { kind: 'failed', stage: 'list', path: pendingDir, error };
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
   * Successful claims are branded handles bound to this reader and clawRoot.
   * Settlement accepts only that exact minted object, never a bare path or clone.
   *
   * phase 1748: opts.readContent === false 时跳过 fs.read（outbox-skip 不读内容、
   * rollback 语义只对已读失败保留）；默认行为不变（drain 调用点零改动）。
   *
   * @param opts readContent === false → claim without reading content
   * @returns ClaimResult
   */
  async claimNext(
    opts: { readContent?: boolean } = {},
  ): Promise<ClaimResult> {
    const listResult = await this.listPendingResult();
    if (listResult.kind === 'failed') {
      return { status: 'io_error', error: formatErr(listResult.error) };
    }
    if (listResult.kind === 'empty') return { status: 'empty' };

    const fileName = listResult.files[0]; // oldest first
    const pendingDir = path.join(this.clawRoot, OUTBOX_PENDING_DIR);
    const processingDir = path.join(this.clawRoot, OUTBOX_PROCESSING_DIR);
    const prepared = await prepareClaimRecord(this.fs, processingDir, 'outbox', fileName);
    const relPendingPath = path.join(pendingDir, fileName);
    const relClaimedPath = path.join(processingDir, prepared.claimName);
    const claimPath = path.join(OUTBOX_PROCESSING_DIR, prepared.claimName);

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
        if (!isFileNotFound(err)) {
          await recordRecoveryIo(new ClaimObservationStore(this.fs, processingDir), this.audit, {
            operation: 'read',
            stage: 'claim_read',
            path: relClaimedPath,
            sourcePath: relClaimedPath,
            targetPath: path.join(pendingDir, fileName),
            completedActions: ['claim'],
            error: err,
            rawName: prepared.claimName,
            originalName: fileName,
          });
        }
        // Roll back through the same no-overwrite staging protocol as startup recovery.
        try {
          await this._restoreClaimToPending(this.clawRoot, relClaimedPath, fileName);
        } catch (rollbackErr) {
          if (rollbackErr instanceof ClaimObservationPersistenceError) throw rollbackErr;
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
            claimPath,
            filename: fileName,
            handle: this.mintClaim(claimPath, fileName, {}),
          };
        }
        return { status: 'io_error', error: reason };
      }
    }

    return this.mintClaim(claimPath, fileName, { status: 'claimed' as const, content });
  }

  private mintClaim<T extends object>(
    claimPath: string,
    filename: string,
    extra: T,
  ): OutboxClaimHandle & T {
    const reader = this;
    const handle = {
      claimPath,
      filename,
      ...extra,
      async markDone(this: OutboxClaimHandle): Promise<void> {
        await reader.markDone(this);
      },
      async markSkipped(this: OutboxClaimHandle): Promise<void> {
        await reader.markSkipped(this);
      },
      async markFailed(this: OutboxClaimHandle, error: unknown): Promise<void> {
        await reader.markFailed(this, error);
      },
    } as OutboxClaimHandle & T;
    this.mintedClaims.add(handle);
    return Object.freeze(handle);
  }

  private beginSettlement(handle: OutboxClaimHandle): void {
    if (!this.mintedClaims.has(handle)) {
      throw new OutboxClaimBindingError('Outbox claim handle was not minted by this reader');
    }
    if (this.claimSettlements.has(handle)) {
      throw new OutboxClaimBindingError(`Outbox claim is already settling or settled: ${handle.claimPath}`);
    }
    this.claimSettlements.set(handle, 'settling');
  }

  private finishSettlement(handle: OutboxClaimHandle): void {
    this.claimSettlements.set(handle, 'settled');
  }

  private retrySettlement(handle: OutboxClaimHandle): void {
    this.claimSettlements.delete(handle);
  }

  private async archiveClaim(
    handle: OutboxClaimHandle,
    kind: 'done' | 'skipped',
  ): Promise<void> {
    this.beginSettlement(handle);
    const processingFullPath = path.join(this.clawRoot, handle.claimPath);
    const doneDir = path.join(this.clawRoot, OUTBOX_DONE_DIR);
    const donePath = path.join(doneDir, `${Date.now()}_${handle.filename}`);
    try {
      await this.fs.ensureDir(doneDir);
      await this.fs.move(processingFullPath, donePath);
    } catch (error) {
      this.retrySettlement(handle);
      emitOutboxClaimFailed(this.audit, {
        file: handle.filename,
        op: kind,
        reason: formatErr(error),
      });
      throw new OutboxMoveFailed(processingFullPath, kind, error);
    }

    this.finishSettlement(handle);
    if (kind === 'done') {
      emitOutboxDelivered(this.audit, { file: handle.filename, deliveredAt: Date.now() });
    } else {
      emitOutboxSkipped(this.audit, { file: handle.filename, skippedAt: Date.now() });
    }
  }

  /** Settle only the exact handle minted by this reader. */
  async markDone(handle: OutboxClaimHandle): Promise<void> {
    await this.archiveClaim(handle, 'done');
  }

  /** Archive without reporting delivery. */
  async markSkipped(handle: OutboxClaimHandle): Promise<void> {
    await this.archiveClaim(handle, 'skipped');
  }

  /**
   * Move processing → failed and atomically persist the consumption reason.
   * Failure throws settlement_required with both errors; it never reports success.
   */
  async markFailed(handle: OutboxClaimHandle, error: unknown): Promise<void> {
    this.beginSettlement(handle);
    const processingFullPath = path.join(this.clawRoot, handle.claimPath);
    const failedDir = path.join(this.clawRoot, OUTBOX_FAILED_DIR);
    const reason = formatErr(error);
    try {
      await this.fs.ensureDir(failedDir);
      let target = this.failedTargets.get(handle);
      if (target === undefined) {
        const failedPath = path.join(
          failedDir,
          `${Date.now()}_${newShortUuid()}_${handle.filename}`,
        );
        target = { message: failedPath, reason: `${failedPath}.reason.json` };
        this.failedTargets.set(handle, target);
      }
      await this.fs.writeAtomicExisting(target.reason, JSON.stringify({
        schema_version: 1,
        reason,
        failed_at: new Date().toISOString(),
        claim_path: handle.claimPath,
        original_filename: handle.filename,
      }, null, 2));
      await this.fs.move(processingFullPath, target.message);
    } catch (settlementError) {
      this.retrySettlement(handle);
      emitOutboxSettlementFailed(this.audit, {
        file: handle.filename,
        claimPath: handle.claimPath,
        reason,
        settlementReason: formatErr(settlementError),
      });
      throw new OutboxSettlementRequired(
        handle.claimPath,
        handle.filename,
        error,
        settlementError,
      );
    }
    this.finishSettlement(handle);
    emitOutboxFailed(this.audit, { file: handle.filename, reason });
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
   */
  async peekLastOutboxPending(): Promise<OutboxPeekResult> {
    const pendingDir = path.join(this.clawRoot, OUTBOX_PENDING_DIR);
    const listed = await this.listPendingResult();
    if (listed.kind === 'failed') {
      emitOutboxPeekFailed(this.audit, {
        file: listed.path,
        stage: 'list',
        reason: formatErr(listed.error),
      });
      return listed;
    }
    if (listed.kind === 'empty') return { kind: 'empty' };
    const latest = listed.files[listed.files.length - 1];
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


/** Preferred construction entry point: every reader is bound to one claw root. */
export function createOutboxReader(options: OutboxReaderOptions): OutboxReader {
  return new OutboxReader(options);
}
