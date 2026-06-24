/**
 * @module L4.ContractSystem.Lifecycle
 * Contract status transitions: pause / resume / cancel / archive / completion check
 */

import type { ContractId } from './types.js';
import type { Contract } from '../contract/types.js';
import type { ProgressData } from './types.js';
import { ARCHIVE_ALLOWED_STATUSES } from './types.js';
import { PROGRESS_CURRENT_SCHEMA_VERSION } from './persistence.js';
import { lockContract, releaseLock, type LockContext } from './lock.js';
import { ToolError } from '../../foundation/errors.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

import {
  emitContractPaused,
  emitContractResumed,
  emitContractCancelled,
  emitContractCrashed,
  emitContractNotifyFailed,
  emitContractArchivePreconditionViolated,
} from './audit-emit.js';

import { type ArchiveDir } from './types.js';

export interface LifecycleContext extends LockContext {
  activeDir: string;
  pausedDir: string;
  archiveDir: ArchiveDir;
  contractDir: (contractId: ContractId) => Promise<string>;
  loadContract: (contractId: ContractId) => Promise<Contract>;
  getProgress: (contractId: ContractId) => Promise<ProgressData | null>;
  saveProgress: (contractId: ContractId, progress: ProgressData) => Promise<void>;
  checkAllSubtasksCompleted: (contractId: ContractId, progress: ProgressData) => Promise<boolean>;
  /** phase 1020 (r124 C fork): cancelContract abort propagation to active verifier subagents */
  abortContractVerifiers: (contractId: ContractId, reason: string) => void;
  /** phase 63: onNotify callback for contract terminal state alerts */
  onNotify?: (type: string, data: Record<string, unknown>) => void;
}

export async function pauseContract(
  ctx: LifecycleContext,
  contractId: ContractId,
  checkpointNote: string,
): Promise<void> {
  const { dir, release: releaseSource } = await lockContract(ctx, contractId, ctx.contractDir);
  if (dir !== ctx.activeDir) {
    await releaseSource();
    throw new ToolError(`Cannot pause contract "${contractId}": not in active/`);
  }
  await ctx.fs.ensureDir(ctx.pausedDir);

  // phase 791 (P0.16): acquire lock at SOURCE, do status update, move, release at TARGET.
  // phase 871 (new.P1.5 r113 G fork): catch fs.move throw + 显式释放 source 防 orphan
  // phase 1162 (r128 D fork DD3): abort verifier before fs.move 防 mid-flight write race
  // phase 1362 (r140): lockContract atomic wrapper covers contractDir→acquireLock TOCTOU race.
  // 防 fs.move 跨边界 lock 失效 race（lock + 数据同 dir / dir move 时 lock 跟着移动）。
  const targetLockPath = `${ctx.pausedDir}/${contractId}/progress.lock`;
  try {
    // status update in SOURCE dir before move (canonical decision crash-safe)
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      throw new ToolError(`Cannot pause contract "${contractId}": progress unavailable (schema corruption)`);
    }
    progress.status = 'paused';
    progress.checkpoint = checkpointNote;
    await ctx.saveProgress(contractId, progress);

    // phase 1162 r128 D fork DD3: abort verifier subagents (best-effort, no-blocking)
    // verifier 走 phase 993 D.1 signal wire → catch → emit VERIFIER_FAILED reason='paused: <checkpoint>'
    try {
      ctx.abortContractVerifiers(contractId, `paused: ${checkpointNote}`);
    } catch (abortErr) {
      // 不破 pause 主流程；abortContractVerifiers 内已 try/catch + audit emit (mirror cancelContract)
    }

    // move whole dir (lock + progress.json) → target
    await ctx.fs.move(`${ctx.activeDir}/${contractId}`, `${ctx.pausedDir}/${contractId}`);
  } catch (err) {
    // fs.move 抛 → source dir 仍含 lock + target dir 未创 → 显式释放 source 防 orphan
    // per feedback_latent_defensive_fix (N=5 累) + feedback_audit_cluster_multi_phase_coordination
    try { await releaseSource(); } catch { /* releaseLock 自身 audit emit + 不阻断 throw chain */ }
    throw err;
  } finally {
    // release at TARGET (lock file moved with dir)
    // 正常 path: target lock = source lock moved with dir → release target ✓
    // exception path (catch 已执行): source 已 release / target 不存在 / releaseLock emit LOCK_UNLINK_FAILED audit
    await releaseLock(ctx, targetLockPath);
  }

  emitContractPaused(ctx.audit, { contractId, checkpoint: checkpointNote });
}

export async function resumeContract(
  ctx: LifecycleContext,
  contractId: ContractId,
): Promise<Contract> {
  const { dir, release: releaseSource } = await lockContract(ctx, contractId, ctx.contractDir);
  if (dir !== ctx.pausedDir) {
    await releaseSource();
    throw new ToolError(`Cannot resume contract "${contractId}": not in paused/`);
  }

  // phase 791 (P0.16): acquire lock at SOURCE, do status update, move, release at TARGET.
  // phase 871 (new.P1.5 r113 G fork): catch fs.move throw + 显式释放 source 防 orphan
  // phase 1362 (r140): lockContract atomic wrapper covers contractDir→acquireLock TOCTOU race.
  const targetLockPath = `${ctx.activeDir}/${contractId}/progress.lock`;
  try {
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      throw new ToolError(`Cannot resume contract "${contractId}": progress unavailable (schema corruption)`);
    }
    progress.status = 'running';
    progress.checkpoint = null;
    await ctx.saveProgress(contractId, progress);

    await ctx.fs.move(`${ctx.pausedDir}/${contractId}`, `${ctx.activeDir}/${contractId}`);
  } catch (err) {
    try { await releaseSource(); } catch (releaseErr) {
      // phase 472 (review N3-L): 原注释承诺 "audit emit"、本 commit 落地
      // phase 558: 加 context col
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.RELEASE_SOURCE_FAILED,
        `contract_id=${contractId}`,
        `context=resume`,
        `error=${formatErr(releaseErr)}`,
      );
    }
    throw err;
  } finally {
    await releaseLock(ctx, targetLockPath);
  }

  emitContractResumed(ctx.audit, { contractId });
  return ctx.loadContract(contractId);
}

export async function cancelContract(
  ctx: LifecycleContext,
  contractId: ContractId,
  reason: string,
): Promise<void> {
  const { dir, release: releaseSource } = await lockContract(ctx, contractId, ctx.contractDir);
  if (dir === ctx.archiveDir) {
    await releaseSource();
    throw new ToolError(`Cannot cancel contract "${contractId}": already archived`);
  }
  await ctx.fs.ensureDir(ctx.archiveDir);

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
  const targetLockPath = `${ctx.archiveDir}/${contractId}/progress.lock`;
  try {
    // (2) canonical decision: saveProgress first (durable cancel mark)
    const progress = await ctx.getProgress(contractId);
    if (!progress) {
      throw new ToolError(`Cannot cancel contract "${contractId}": progress unavailable (schema corruption)`);
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
    await ctx.fs.move(`${dir}/${contractId}`, `${ctx.archiveDir}/${contractId}`);
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
      // phase 558: 加 context col 区分 4 lifecycle 路径（resume/cancel/crash/archive）
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.RELEASE_SOURCE_FAILED,
        `contract_id=${contractId}`,
        `context=cancel`,
        `error=${formatErr(releaseErr)}`,
      );
    }
    throw err;
  } finally {
    await releaseLock(ctx, targetLockPath);
  }

  emitContractCancelled(ctx.audit, { contractId, reason });
  safeNotify(ctx, 'contract_cancelled', { contractId, reason });
}

// phase 63: safe notify wrapper for lifecycle functions
function safeNotify(
  ctx: LifecycleContext,
  type: 'contract_cancelled' | 'contract_crashed',
  data: Record<string, unknown>,
): void {
  try {
    ctx.onNotify?.(type, data);
  } catch (err) {
    emitContractNotifyFailed(ctx.audit, { notifyType: type, error: formatErr(err) });
  }
}

/**
 * phase 63: ContractSystem 新增 markCrashed 入口
 *
 * 与 cancelContract 对称、但语义不同：
 * - cancelContract: 主动决策中止（user CLI / system 决定停）
 * - markCrashed:    被动崩（agent 物理推不动、Runtime catch 5 typed Error 触发）
 *
 * 流程：lockContract / saveProgress(crashed) / abortContractVerifiers / fs.move source → archive / release / emit audit / safeNotify
 */
export async function markCrashed(
  ctx: LifecycleContext,
  contractId: ContractId,
  cause: string,
): Promise<void> {
  const { dir, release: releaseSource } = await lockContract(ctx, contractId, ctx.contractDir);
  if (dir === ctx.archiveDir) {
    await releaseSource();
    throw new ToolError(`Cannot mark crashed contract "${contractId}": already archived`);
  }
  await ctx.fs.ensureDir(ctx.archiveDir);

  const targetLockPath = `${ctx.archiveDir}/${contractId}/progress.lock`;
  try {
    // (2) canonical decision: saveProgress first (durable crashed mark)
    let progress: ProgressData;
    try {
      const p = await ctx.getProgress(contractId);
      if (!p) {
        throw new Error('progress unavailable (schema corruption)');
      }
      progress = p;
    } catch (getProgressErr) {
      // phase 66: progress.json 自身 schema corruption → fallback minimal progress
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.MARK_CRASHED_GRACEFUL_FALLBACK,
        // phase 575: col 命名 contract_id 统一 snake_case
        // （与同文件 CANCEL_PARTIAL_FAILED + CRASH_PARTIAL_FAILED + phase 140 id-naming + snapshot.json schema 一致）
        `contract_id=${contractId}`,
        `reason=getProgress_failed`,
        `cause=${cause}`,
        `error=${formatErr(getProgressErr)}`,
      );
      progress = {
        schema_version: PROGRESS_CURRENT_SCHEMA_VERSION,
        contract_id: contractId,
        status: 'crashed',
        checkpoint: `crashed: ${cause}`,
        subtasks: {},
      };
    }
    progress.status = 'crashed';
    progress.checkpoint = `crashed: ${cause}`;
    await ctx.saveProgress(contractId, progress);

    // (3) abort verifier subagents (best-effort)
    try {
      ctx.abortContractVerifiers(contractId, cause);
    } catch (abortErr) {
      // silent: abort verifier best-effort, markCrashed main flow must not break
    }

    // (4) move whole dir
    await ctx.fs.move(`${dir}/${contractId}`, `${ctx.archiveDir}/${contractId}`);
  } catch (err) {
    // phase 427 Step A (review medium audit-emit-implies-no-write、phase 422 follow-up):
    // saveProgress 已写 'crashed' 到 source dir、fs.move 失败 → 半态 (source 含 crashed
    // progress、target dir 缺/半成)。emit audit 留痕、boot reconcile / 运维可追。
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.CRASH_PARTIAL_FAILED,
      `contract_id=${contractId}`,
      `cause=${cause}`,
      `error=${formatErr(err)}`,
    );
    try { await releaseSource(); } catch (releaseErr) {
      // phase 472 (review N3-L): observability — releaseSource 失败 audit emit
      // phase 558: 加 context col
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.RELEASE_SOURCE_FAILED,
        `contract_id=${contractId}`,
        `context=crash`,
        `error=${formatErr(releaseErr)}`,
      );
    }
    throw err;
  } finally {
    await releaseLock(ctx, targetLockPath);
  }

  emitContractCrashed(ctx.audit, { contractId, cause });
  safeNotify(ctx, 'contract_crashed', { contractId, cause });
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
): Promise<void> {
  const { dir, release: releaseSource } = await lockContract(ctx, contractId, ctx.contractDir);
  if (dir === ctx.archiveDir) {
    await releaseSource();
    return;
  }

  // NEW phase 188 Step A: archive precondition / status 必须终态
  const progress = await ctx.getProgress(contractId);
  if (!progress) {
    await releaseSource();
    throw new ToolError(`Contract "${contractId}" progress unavailable: cannot archive`);
  }
  // phase 351: cast string for typed Set runtime check (mirror phase 344 stripDerivableStatus pattern)
  if (!(ARCHIVE_ALLOWED_STATUSES as ReadonlySet<string>).has(progress.status)) {
    emitContractArchivePreconditionViolated(
      ctx.audit,
      { contractId, status: progress.status, context: 'moveContractToArchive' },
    );
    await releaseSource();
    throw new ToolError(
      `Contract "${contractId}" cannot be archived: status=${progress.status} (expected terminal)`,
    );
  }

  const dst = `${ctx.archiveDir}/${contractId}`;
  await ctx.fs.ensureDir(ctx.archiveDir);

  // phase 860 (P0-B): acquire lock at SOURCE / move dir / release@TARGET
  // phase 871 (new.P1.5 r113 G fork): catch fs.move throw + 显式释放 source 防 orphan
  // phase 1362 (r140): lockContract atomic wrapper covers contractDir→acquireLock TOCTOU race.
  // mirror phase 791 P0.16 template (pause/resume/cancel sister)
  const targetLockPath = `${dst}/progress.lock`;
  try {
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
    await releaseLock(ctx, targetLockPath);
  }
}
