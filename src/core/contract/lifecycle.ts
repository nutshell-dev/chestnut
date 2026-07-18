/**
 * @module L4.ContractSystem.Lifecycle
 * Contract status transitions: cancel / archive / completion check (phase 1123 Step C)
 */

import type { ContractId, ArchiveState } from './types.js';
import type { Contract } from '../contract/types.js';
import type { ProgressData } from './types.js';
import { ARCHIVE_STATES } from './types.js';
import { PROGRESS_CURRENT_SCHEMA_VERSION } from './persistence.js';
import { lockContract, releaseLock, type LockContext } from './lock.js';
import { ToolError } from '../../foundation/tools/errors.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import type { ContractCorruptionEvidence } from './types.js';

import {
  emitContractCancelled,
  emitContractCorrupted,
  emitContractCorruptPartialFailed,
  emitContractNotifyFailed,
  emitContractArchivePreconditionViolated,
  emitContractArchiveTargetExists,
} from './audit-emit.js';

import { type ArchiveDir } from './types.js';
import { archiveStateContainerDir } from './locations.js';

export interface LifecycleContext extends LockContext {
  activeDir: string;
  archiveDir: ArchiveDir;
  contractDir: (contractId: ContractId) => Promise<string>;
  loadContract: (contractId: ContractId) => Promise<Contract>;
  getProgress: (contractId: ContractId) => Promise<ProgressData | null>;
  saveProgress: (contractId: ContractId, progress: ProgressData, knownDir?: string) => Promise<void>;
  checkAllSubtasksCompleted: (contractId: ContractId, progress: ProgressData) => Promise<boolean>;
  /** phase 1020 (r124 C fork): cancelContract abort propagation to active verifier subagents */
  abortContractVerifiers: (contractId: ContractId, reason: string) => void;
  /** phase 63: onNotify callback for contract terminal state alerts */
  onNotify?: (type: string, data: Record<string, unknown>) => void;
}

export async function cancelContract(
  ctx: LifecycleContext,
  contractId: ContractId,
  reason: string,
): Promise<void> {
  const { dir, release: releaseSource, ownerToken } = await lockContract(ctx, contractId, ctx.contractDir);
  if (dir.startsWith(ctx.archiveDir)) {
    await releaseSource();
    throw new ToolError(`Cannot cancel contract "${contractId}": already archived`);
  }
  const targetDir = archiveStateContainerDir(ctx.archiveDir, 'cancelled');
  await ctx.fs.ensureDir(targetDir);

  // phase 1152 G.5 (r127 G fork): canonical decision point = saveProgress(cancelled) BEFORE abort
  // 原因：crash 在 abort 后 saveProgress 前 → verifier 已死、status 还 'running' → boot reconcile 不识别 cancel
  // saveProgress 提前：crash window 内 progress.json 已 cancelled、boot reconcile 自然识别
  //
  // op 顺序：
  //   1. lockContract atomic acquire at SOURCE (covers TOCTOU race, phase 1362 r140)
  //   2. saveProgress(cancelled) 写 source dir progress.json (canonical decision)
  //   3. abortContractVerifiers (best-effort, outer try/catch)
  //   4. fs.move source → archive
  //   5. releaseLock at TARGET
  const targetDirPath = `${targetDir}/${contractId}`;
  const targetLockPath = `${targetDirPath}/progress.lock`;
  try {
    // (2) canonical decision: saveProgress first (durable cancel mark)
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      throw new ToolError(`Cannot cancel contract "${contractId}": progress unavailable (schema corruption)`);
    }
    // Phase 967: reset leftover in_progress subtasks so archived contract does
    // not carry stale verification state.
    for (const subtask of Object.values(progress.subtasks)) {
      if (subtask.status === 'in_progress') {
        subtask.status = 'todo';
        delete subtask.verification_attempt_id;
      }
    }
    progress.status = 'cancelled';
    progress.checkpoint = `cancelled: ${reason}`;
    await ctx.saveProgress(contractId, progress);

    // (3) abort verifier subagents (best-effort, no-blocking)
    // crash here: progress.json 已 cancelled、boot reconcile 自然识别 / verifier 已被 abort 或自然死亡
    try {
      ctx.abortContractVerifiers(contractId, reason);
    } catch (abortErr) {
      // 不破 cancel 主流程；abortContractVerifiers 内已 try/catch + audit emit
      // 此处仅 outer 保险（按 M#10 不合理停下、subordinate failure 不阻 superordinate flow）
    }

    // (4) move whole dir
    if (await ctx.fs.exists(targetDirPath)) {
      emitContractArchiveTargetExists(ctx.audit, {
        contractId,
        targetPath: targetDirPath,
        context: 'cancelContract',
      });
      throw new ToolError(`Cannot cancel contract "${contractId}": target already exists at ${targetDirPath}`);
    }
    await ctx.fs.move(`${dir}/${contractId}`, targetDirPath);
  } catch (err) {
    // phase 422 Step C (review medium audit-emit-implies-no-write): saveProgress
    // 已写 'cancelled' 到 source dir、fs.move 失败 → 半态 (source 含 cancelled
    // progress、target dir 缺/半成)。emit audit 留痕、boot reconcile / 运维可追。
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.CANCEL_PARTIAL_FAILED,
      `contract_id=${contractId}`,
      `reason=${reason}`,
      `error=${formatErr(err)}`,
    );
    try { await releaseSource(); } catch (releaseErr) {
      // phase 472 (review N3-L): 原注释承诺 "audit emit"、本 commit 落地
      // phase 558: 加 context col 区分 lifecycle 路径（cancel/crash/archive）
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.RELEASE_SOURCE_FAILED,
        `contract_id=${contractId}`,
        `context=cancel`,
        `error=${formatErr(releaseErr)}`,
      );
    }
    throw err;
  } finally {
    await releaseLock(ctx, targetLockPath, ownerToken);
  }

  emitContractCancelled(ctx.audit, { contractId, reason });
  safeNotify(ctx, 'contract_cancelled', { contractId, reason });
}

function safeNotify(
  ctx: LifecycleContext,
  type: 'contract_cancelled',
  data: Record<string, unknown>,
): void {
  try {
    ctx.onNotify?.(type, data);
  } catch (err) {
    emitContractNotifyFailed(ctx.audit, { notifyType: type, error: formatErr(err) });
  }
}

/**
 * phase 1121 Step C: ContractSystem 纯资源 corruption 入口
 *
 * 前置条件：调用者已成功将损坏文件隔离到 Contract 内 corrupted/ 目录。
 * 本函数只处理已确认的持久化损坏：写 archive_corrupted marker、abort verifier、
 * move source → archive、emit audit。不发送业务 notify。
 *
 * 与 cancelContract 对称但语义不同：
 * - cancelContract: 主动决策中止
 * - markCorrupted:  已确认的 Contract 持久化资源损坏
 */
export async function markCorrupted(
  ctx: LifecycleContext,
  contractId: ContractId,
  evidence: ContractCorruptionEvidence,
  knownDir?: string,
): Promise<void> {
  const contractDirResolver = knownDir !== undefined
    ? () => Promise.resolve(knownDir)
    : ctx.contractDir;
  const { dir, release: releaseSource, ownerToken } = await lockContract(ctx, contractId, contractDirResolver);
  if (dir.startsWith(ctx.archiveDir)) {
    await releaseSource();
    throw new ToolError(`Cannot mark corrupted contract "${contractId}": already archived`);
  }
  const targetDir = archiveStateContainerDir(ctx.archiveDir, 'corrupted');
  await ctx.fs.ensureDir(targetDir);

  const targetDirPath = `${targetDir}/${contractId}`;
  const targetLockPath = `${targetDirPath}/progress.lock`;
  try {
    // (2) canonical decision: saveProgress first (durable archive_corrupted marker)
    let progress: ProgressData;
    try {
      const p = await ctx.getProgress(contractId);
      if (!p) {
        throw new Error('progress unavailable (schema corruption)');
      }
      progress = p;
    } catch (getProgressErr) {
      // progress.json 自身不可读 → 创建最小过渡 payload，保留 evidence 引用
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.MARK_CORRUPTED_GRACEFUL_FALLBACK,
        `contract_id=${contractId}`,
        `reason=getProgress_failed`,
        `corruption_reason=${evidence.reason}`,
        `error=${formatErr(getProgressErr)}`,
      );
      progress = {
        schema_version: PROGRESS_CURRENT_SCHEMA_VERSION,
        contract_id: contractId,
        status: 'archive_corrupted',
        checkpoint: `archive_corrupted: ${evidence.reason} (${evidence.relativePath})`,
        subtasks: {},
      };
    }
    // Phase 967: reset leftover in_progress subtasks so archived contract does
    // not carry stale verification state.
    for (const subtask of Object.values(progress.subtasks)) {
      if (subtask.status === 'in_progress') {
        subtask.status = 'todo';
        delete subtask.verification_attempt_id;
      }
    }
    progress.status = 'archive_corrupted';
    progress.checkpoint = `archive_corrupted: ${evidence.reason} (${evidence.relativePath})`;
    await ctx.saveProgress(contractId, progress, knownDir);

    // (3) abort verifier subagents (best-effort)
    try {
      ctx.abortContractVerifiers(contractId, evidence.reason);
    } catch (abortErr) {
      // silent: abort verifier best-effort, markCorrupted main flow must not break
    }

    // (4) move whole dir
    if (await ctx.fs.exists(targetDirPath)) {
      emitContractArchiveTargetExists(ctx.audit, {
        contractId,
        targetPath: targetDirPath,
        context: 'markCorrupted',
      });
      throw new ToolError(`Cannot mark corrupted contract "${contractId}": target already exists at ${targetDirPath}`);
    }
    await ctx.fs.move(`${dir}/${contractId}`, targetDirPath);
  } catch (err) {
    // saveProgress 已写 'archive_corrupted' 到 source dir、fs.move 失败 → 半态。
    // emit audit 留痕、boot reconcile / 运维可追。
    emitContractCorruptPartialFailed(
      ctx.audit,
      {
        contractId,
        reason: evidence.reason,
        evidencePath: evidence.relativePath,
        error: formatErr(err),
      },
    );
    try { await releaseSource(); } catch (releaseErr) {
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.RELEASE_SOURCE_FAILED,
        `contract_id=${contractId}`,
        `context=corrupt`,
        `error=${formatErr(releaseErr)}`,
      );
    }
    throw err;
  } finally {
    await releaseLock(ctx, targetLockPath, ownerToken);
  }

  emitContractCorrupted(ctx.audit, {
    contractId,
    reason: evidence.reason,
    evidencePath: evidence.relativePath,
  });
}

export async function isContractComplete(
  ctx: LifecycleContext,
  contractId: ContractId,
): Promise<boolean> {
  const progress = await ctx.getProgress(contractId);
  if (!progress) return false;
  return ctx.checkAllSubtasksCompleted(contractId, progress);
}

// phase 351: ARCHIVE_ALLOWED_STATUSES 复用 types.ts (ML#1 共用基础设施单源、mirror phase 347/348 pattern)

export async function moveContractToArchive(
  ctx: LifecycleContext,
  contractId: ContractId,
  targetState: ArchiveState,
): Promise<void> {
  if (!(ARCHIVE_STATES as ReadonlySet<string>).has(targetState)) {
    throw new ToolError(`Invalid archive state "${targetState}"`);
  }

  const { dir, release: releaseSource, ownerToken } = await lockContract(ctx, contractId, ctx.contractDir);
  if (dir.startsWith(ctx.archiveDir)) {
    await releaseSource();
    return;
  }

  // NEW phase 188 Step A: archive precondition / status 必须终态
  const progress = await ctx.getProgress(contractId);
  if (!progress) {
    await releaseSource();
    throw new ToolError(`Contract "${contractId}" progress unavailable: cannot archive`);
  }
  // phase 351 / 1127 Step D: cast string for typed Set runtime check.
  // Only statuses with a current state subdirectory may use moveContractToArchive;
  // crashed / archive_pending_recovery have no state directory and must not be guessed.
  const DIRECT_ARCHIVE_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'archive_corrupted']);
  if (!DIRECT_ARCHIVE_STATUSES.has(progress.status)) {
    emitContractArchivePreconditionViolated(
      ctx.audit,
      { contractId, status: progress.status, context: 'moveContractToArchive' },
    );
    await releaseSource();
    throw new ToolError(
      `Contract "${contractId}" cannot be archived: status=${progress.status} (expected terminal)`,
    );
  }

  const targetDir = archiveStateContainerDir(ctx.archiveDir, targetState);
  await ctx.fs.ensureDir(targetDir);
  const dst = `${targetDir}/${contractId}`;

  // phase 860 (P0-B): acquire lock at SOURCE / move dir / release@TARGET
  // phase 871 (new.P1.5 r113 G fork): catch fs.move throw + 显式释放 source 防 orphan
  // phase 1362 (r140): lockContract atomic wrapper covers contractDir→acquireLock TOCTOU race.
  // mirror phase 791 P0.16 template (cancel sister)
  const targetLockPath = `${dst}/progress.lock`;
  try {
    if (await ctx.fs.exists(dst)) {
      emitContractArchiveTargetExists(ctx.audit, {
        contractId,
        targetPath: dst,
        context: 'moveContractToArchive',
      });
      throw new ToolError(`Cannot archive contract "${contractId}": target already exists at ${dst}`);
    }
    await ctx.fs.move(`${dir}/${contractId}`, dst);
  } catch (err) {
    try { await releaseSource(); } catch (releaseErr) {
      // phase 472 (review N3-L): 原注释承诺 "audit emit"、本 commit 落地
      // phase 558: 加 context col
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.RELEASE_SOURCE_FAILED,
        `contract_id=${contractId}`,
        `context=archive`,
        `error=${formatErr(releaseErr)}`,
      );
    }
    throw err;
  } finally {
    // release at TARGET (lock file moved with dir)
    await releaseLock(ctx, targetLockPath, ownerToken);
  }
}
