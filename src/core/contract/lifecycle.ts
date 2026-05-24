/**
 * @module L4.ContractSystem.Lifecycle
 * Contract status transitions: pause / resume / cancel / archive / completion check
 */

import type { Contract } from '../contract/types.js';
import type { ProgressData } from './types.js';
import { acquireLock, releaseLock, type LockContext } from './lock.js';
import { ToolError } from '../../foundation/errors.js';

import {
  emitContractPaused,
  emitContractResumed,
  emitContractCancelled,
} from './audit-emit.js';

export interface LifecycleContext extends LockContext {
  activeDir: string;
  pausedDir: string;
  archiveDir: string;
  contractDir: (contractId: string) => Promise<string>;
  loadContract: (contractId: string) => Promise<Contract>;
  getProgress: (contractId: string) => Promise<ProgressData>;
  saveProgress: (contractId: string, progress: ProgressData) => Promise<void>;
  checkAllSubtasksCompleted: (contractId: string, progress: ProgressData) => Promise<boolean>;
  /** phase 1020 (r124 C fork): cancelContract abort propagation to active verifier subagents */
  abortContractVerifiers: (contractId: string, reason: string) => void;
}

export async function pauseContract(
  ctx: LifecycleContext,
  contractId: string,
  checkpointNote: string,
): Promise<void> {
  const dir = await ctx.contractDir(contractId);
  if (dir !== ctx.activeDir) {
    throw new ToolError(`Cannot pause contract "${contractId}": not in active/`);
  }
  await ctx.fs.ensureDir(ctx.pausedDir);

  // phase 791 (P0.16): acquire lock at SOURCE, do status update, move, release at TARGET.
  // phase 871 (new.P1.5 r113 G fork): catch fs.move throw + 显式释放 source 防 orphan
  // phase 1162 (r128 D fork DD3): abort verifier before fs.move 防 mid-flight write race
  // 防 fs.move 跨边界 lock 失效 race（lock + 数据同 dir / dir move 时 lock 跟着移动）。
  const sourceLockPath = `${ctx.activeDir}/${contractId}/progress.lock`;
  const targetLockPath = `${ctx.pausedDir}/${contractId}/progress.lock`;
  await acquireLock(ctx, sourceLockPath);
  try {
    // status update in SOURCE dir before move (canonical decision crash-safe)
    const progress = await ctx.getProgress(contractId);
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
    try { await releaseLock(ctx, sourceLockPath); } catch { /* releaseLock 自身 audit emit + 不阻断 throw chain */ }
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
  contractId: string,
): Promise<Contract> {
  const dir = await ctx.contractDir(contractId);
  if (dir !== ctx.pausedDir) {
    throw new ToolError(`Cannot resume contract "${contractId}": not in paused/`);
  }

  // phase 791 (P0.16): acquire lock at SOURCE, do status update, move, release at TARGET.
  // phase 871 (new.P1.5 r113 G fork): catch fs.move throw + 显式释放 source 防 orphan
  const sourceLockPath = `${ctx.pausedDir}/${contractId}/progress.lock`;
  const targetLockPath = `${ctx.activeDir}/${contractId}/progress.lock`;
  await acquireLock(ctx, sourceLockPath);
  try {
    const progress = await ctx.getProgress(contractId);
    progress.status = 'running';
    progress.checkpoint = null;
    await ctx.saveProgress(contractId, progress);

    await ctx.fs.move(`${ctx.pausedDir}/${contractId}`, `${ctx.activeDir}/${contractId}`);
  } catch (err) {
    try { await releaseLock(ctx, sourceLockPath); } catch { /* audit emit + 不阻断 throw chain */ }
    throw err;
  } finally {
    await releaseLock(ctx, targetLockPath);
  }

  emitContractResumed(ctx.audit, { contractId });
  return ctx.loadContract(contractId);
}

export async function cancelContract(
  ctx: LifecycleContext,
  contractId: string,
  reason: string,
): Promise<void> {
  const dir = await ctx.contractDir(contractId);
  if (dir === ctx.archiveDir) {
    throw new ToolError(`Cannot cancel contract "${contractId}": already archived`);
  }
  await ctx.fs.ensureDir(ctx.archiveDir);

  // phase 1152 G.5 (r127 G fork): canonical decision point = saveProgress(cancelled) BEFORE abort
  // 原因：crash 在 abort 后 saveProgress 前 → verifier 已死、status 还 'running' → boot reconcile 不识别 cancel
  // saveProgress 提前：crash window 内 progress.json 已 cancelled、boot reconcile 自然识别
  //
  // op 顺序：
  //   1. acquireLock at SOURCE (lock first)
  //   2. saveProgress(cancelled) 写 source dir progress.json (canonical decision)
  //   3. abortContractVerifiers (best-effort, outer try/catch)
  //   4. fs.move source → archive
  //   5. releaseLock at TARGET
  const sourceLockPath = `${dir}/${contractId}/progress.lock`;
  const targetLockPath = `${ctx.archiveDir}/${contractId}/progress.lock`;
  await acquireLock(ctx, sourceLockPath);
  try {
    // (2) canonical decision: saveProgress first (durable cancel mark)
    const progress = await ctx.getProgress(contractId);
    progress.status = 'cancelled';
    progress.checkpoint = `cancelled: ${reason}`;
    await ctx.saveProgress(contractId, progress);

    // (3) abort verifier subagents (best-effort, no-blocking)
    // crash here: progress.json 已 cancelled、boot reconcile 自然识别 / verifier 已被 abort 或自然死亡
    try {
      ctx.abortContractVerifiers(contractId, reason);
    } catch (abortErr) {
      // 不破 cancel 主流程；abortContractVerifiers 内已 try/catch + audit emit
      // 此处仅 outer 保险（按 ML#10 不合理停下、subordinate failure 不阻 superordinate flow）
    }

    // (4) move whole dir
    await ctx.fs.move(`${dir}/${contractId}`, `${ctx.archiveDir}/${contractId}`);
  } catch (err) {
    try { await releaseLock(ctx, sourceLockPath); } catch { /* audit emit + 不阻断 throw chain */ }
    throw err;
  } finally {
    await releaseLock(ctx, targetLockPath);
  }

  emitContractCancelled(ctx.audit, { contractId, reason });
}

export async function isContractComplete(
  ctx: LifecycleContext,
  contractId: string,
): Promise<boolean> {
  const progress = await ctx.getProgress(contractId);
  return ctx.checkAllSubtasksCompleted(contractId, progress);
}

export async function moveContractToArchive(
  ctx: LifecycleContext,
  contractId: string,
): Promise<void> {
  const dir = await ctx.contractDir(contractId);
  if (dir === ctx.archiveDir) return;
  const dst = `${ctx.archiveDir}/${contractId}`;
  await ctx.fs.ensureDir(ctx.archiveDir);

  // phase 860 (P0-B): acquire lock at SOURCE / move dir / release@TARGET
  // phase 871 (new.P1.5 r113 G fork): catch fs.move throw + 显式释放 source 防 orphan
  // mirror phase 791 P0.16 template (pause/resume/cancel sister)
  const sourceLockPath = `${dir}/${contractId}/progress.lock`;
  const targetLockPath = `${dst}/progress.lock`;
  await acquireLock(ctx, sourceLockPath);
  try {
    await ctx.fs.move(`${dir}/${contractId}`, dst);
  } catch (err) {
    try { await releaseLock(ctx, sourceLockPath); } catch { /* audit emit + 不阻断 throw chain */ }
    throw err;
  } finally {
    // release at TARGET (lock file moved with dir)
    await releaseLock(ctx, targetLockPath);
  }
}
