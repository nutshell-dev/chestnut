/**
 * @module L4.ContractSystem.Lock
 * Contract progress lock primitives — 函数化 / 0 class state
 *
 * phase 1048: 内部实现迁移到 per-contender 文件锁协议。
 *   - acquireLock/releaseLock 使用 foundation/fs/lock-protocol 的
 *     tryAcquireClaim/releaseClaim。
 *   - 保留旧格式 progress.lock 的兼容读取路径（migrateLegacyLock）。
 *   - lockContract 的 post-lock re-verify TOCTOU 保护保持不变。
 */

import * as path from 'path';
import { z } from 'zod';
import { formatErr } from "../../foundation/node-utils/index.js";
import type { FileSystem } from '../../foundation/fs/index.js';

import type { AuditLog } from '../../foundation/audit/index.js';
import { FileNotFoundError, isFileNotFound } from '../../foundation/fs/index.js';
import { LOCK_MAX_RETRIES, LOCK_RETRY_DELAY_MS } from './constants.js';
import {
  emitContractLockUnlinkFailed,
  emitContractLockRetry,
} from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { isAlive as defaultL1IsAlive, makeProcessStartTime } from '../../foundation/process-exec/index.js';
import type { ProcessStartTime } from '../../foundation/process-exec/index.js';
import { type ContractId } from './types.js';
import { LockContentionExhaustedError, LockConflictError } from './errors.js';
import { tryAcquireClaim, releaseClaim } from '../../foundation/fs/lock-protocol.js';

// phase 326 Zod SoT (ML#9 优先编译器检查): inline lock metadata schemas
// LockMetadataSchema: acquire 路径、{ pid, time } 必为有限数
// LockMetadataReleaseSchema: release verify 路径、subset (pid only)
const LockMetadataReleaseSchema = z.object({
  pid: z.number().finite(),
  ownerToken: z.string(),
});

export interface LockContext {
  fs: FileSystem;
  audit: AuditLog;
  l1IsAlive?: typeof defaultL1IsAlive;
  /** phase 1028: injectable lock retry budget — defaults to LOCK_MAX_RETRIES */
  lockMaxRetries?: number;
  /** phase 1028: injectable lock retry delay (ms) — defaults to LOCK_RETRY_DELAY_MS */
  lockRetryDelayMs?: number;
}

/**
 * phase 1048: 同进程内对同一 lockDir 的锁需要串行化。
 *
 * per-contender 协议的 stale recovery 会把同 pid 的其它 claim 视为上次 crash
 * 残留并删除；这在同进程并发持锁时会破坏互斥。因此在本进程内用内存互斥量
 * 保证每个 lockDir 同时只有一个持有者（从 acquire 到 release）。
 */
class LockDirMutex {
  // 按 FileSystem 实例隔离：不同 ContractSystem / 不同测试的相对路径不会互相阻塞。
  private pending = new Map<FileSystem, Map<string, Promise<void>>>();

  async acquire(fs: FileSystem, lockDir: string): Promise<() => void> {
    let fsMap = this.pending.get(fs);
    if (!fsMap) {
      fsMap = new Map();
      this.pending.set(fs, fsMap);
    }
    const previous = fsMap.get(lockDir);
    let release: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    fsMap.set(lockDir, promise);
    if (previous) {
      await previous;
    }
    return () => {
      fsMap!.delete(lockDir);
      if (fsMap!.size === 0) {
        this.pending.delete(fs);
      }
      release();
    };
  }
}

const lockDirMutex = new LockDirMutex();
const activeMutexReleasers = new Map<string, () => void>();

export async function acquireLock(ctx: LockContext, lockPath: string): Promise<string> {
  // lockPath 语义：旧格式是 <contractDir>/progress.lock，新协议 lockDir 是 <contractDir>
  const lockDir = path.dirname(lockPath);

  // 先获取同进程互斥量，持锁期间阻塞同进程内其它同 lockDir 的 acquire
  const releaseMutex = await lockDirMutex.acquire(ctx.fs, lockDir);

  try {
    const claimsDir = `${lockDir}/claims`;

    // 确保 lockDir 存在（兼容旧调用方以及新协议 claims 父目录）
    await ctx.fs.ensureDir(lockDir);

    // phase 1048: 旧格式兼容。claims/ 不存在且旧 progress.lock 存在时，先判活再迁移。
    const hasClaims = await ctx.fs.exists(claimsDir).catch(() => false);
    const hasLegacyLock = !hasClaims && (await ctx.fs.exists(lockPath).catch(() => false));
    if (hasLegacyLock) {
      await migrateLegacyLock(ctx, lockPath, lockDir);
    }

    // per-contender 协议
    const maxRetries = ctx.lockMaxRetries ?? LOCK_MAX_RETRIES;
    const retryDelayMs = ctx.lockRetryDelayMs ?? LOCK_RETRY_DELAY_MS;

    let lastReason = 'unknown';
    for (let i = 0; i < maxRetries; i++) {
      const ownerToken = await tryAcquireClaim(
        { fs: ctx.fs, audit: ctx.audit, isAlive: ctx.l1IsAlive },
        lockDir,
      );
      if (ownerToken !== null) {
        activeMutexReleasers.set(ownerToken, releaseMutex);
        return ownerToken;
      }

      lastReason = 'election lost to another contender';
      if (i < maxRetries - 1) {
        // jitter range [T/2, 1.5T]
        const delayMs = retryDelayMs / 2 + Math.random() * retryDelayMs;
        emitContractLockRetry(ctx.audit, {
          attempt: i + 1,
          max_retries: maxRetries,
          reason: lastReason,
          delay_ms: Math.round(delayMs),
        });
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw new LockContentionExhaustedError(lockDir, maxRetries);
  } catch (err) {
    releaseMutex();
    throw err;
  }
}

/**
 * phase 1048: 旧格式 progress.lock 兼容迁移。
 *
 * 调用前提：claims/ 目录不存在且 lockPath 存在。
 *   - 若旧锁持有者存活 → fail-closed，抛 LockConflictError。
 *   - 若持有者已死或文件不可读 → 删除旧锁，后续 acquire 走新协议并创建 claims/。
 */
async function migrateLegacyLock(ctx: LockContext, lockPath: string, _lockDir: string): Promise<void> {
  try {
    const raw = await ctx.fs.read(lockPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 非法 JSON → 直接删除旧锁
      await ctx.fs.delete(lockPath).catch(() => {});
      ctx.audit.write(CONTRACT_AUDIT_EVENTS.LOCK_CLAIM_LEGACY_FORMAT_MIGRATED, `path=${lockPath}`, 'reason=unparseable');
      return;
    }

    const pid = typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).pid
      : undefined;
    const startTime = typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).startTime
      : undefined;

    if (typeof pid !== 'number') {
      // 旧锁内容不含有效 pid → 视为死锁/损坏，直接删除
      await ctx.fs.delete(lockPath).catch(() => {});
      ctx.audit.write(CONTRACT_AUDIT_EVENTS.LOCK_CLAIM_LEGACY_FORMAT_MIGRATED, `path=${lockPath}`, 'reason=no_pid');
      return;
    }

    const isAliveFn = ctx.l1IsAlive ?? defaultL1IsAlive;
    const expectedStartTime: ProcessStartTime | undefined = typeof startTime === 'string' ? makeProcessStartTime(startTime) : undefined;
    if (isAliveFn(pid, expectedStartTime)) {
      // 旧锁持有者存活 → 不迁移，让它正常释放
      throw new LockConflictError(lockPath, `Legacy lock held by live PID ${pid}`);
    }

    // 持有者已死 → 删旧锁，后续 acquire 会创建 claims/
    await ctx.fs.delete(lockPath).catch(() => {});
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.LOCK_CLAIM_LEGACY_FORMAT_MIGRATED,
      `path=${lockPath}`,
      `pid=${pid}`,
      'reason=holder_dead',
    );
  } catch (err) {
    if (err instanceof LockConflictError) throw err;
    // 读失败/其他错误 → 删旧锁后迁移
    await ctx.fs.delete(lockPath).catch(() => {});
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.LOCK_CLAIM_LEGACY_FORMAT_MIGRATED,
      `path=${lockPath}`,
      `reason=${formatErr(err)}`,
    );
  }
}

export async function unlinkStaleLock(ctx: LockContext, lockPath: string, reason: string): Promise<boolean> {
  try {
    await ctx.fs.delete(lockPath);
    return true;
  } catch (err: unknown) {
    if (err instanceof FileNotFoundError) return true;
    // phase 289 Step C: drop emitContractLockCleanupFailed to avoid dual emit;
    // keep only emitContractLockUnlinkFailed (symmetric with sibling callers
    // line 151/169/184) so a single failure produces a single audit row.
    // phase 721: 加 path col、与 L163/L180/L195 其他 3 callers 形态对齐
    emitContractLockUnlinkFailed(
      ctx.audit,
      { path: lockPath, reason, error: formatErr(err) },
    );
    return false;
  }
}

export async function releaseLock(ctx: LockContext, lockPath: string, ownerToken: string): Promise<void> {
  const lockDir = path.dirname(lockPath);
  const claimsDir = `${lockDir}/claims`;

  // phase 1048: 释放同进程互斥量（无论文件锁是否成功释放都要释放）
  const releaseMutex = activeMutexReleasers.get(ownerToken);
  if (releaseMutex) {
    activeMutexReleasers.delete(ownerToken);
    releaseMutex();
  }

  // phase 1048: 新协议路径 — 只删除文件名含自己 token 的 claim
  const hasClaims = await ctx.fs.exists(claimsDir).catch(() => false);
  if (hasClaims) {
    await releaseClaim({ fs: ctx.fs, audit: ctx.audit }, lockDir, ownerToken);
    return;
  }

  // 旧格式路径（兼容未迁移的锁）：保留现有 restore/no-replace 逻辑作为 fallback
  // Atomic claim: rename the lock file to a "released" path that includes our token.
  // If the lock was already replaced by another owner, the rename target will be
  // different and our token check will fail against the post-rename file.
  const releasedPath = `${lockPath}.released-${ownerToken}`;
  try {
    await ctx.fs.move(lockPath, releasedPath);
  } catch (moveErr) {
    if (isFileNotFound(moveErr)) return; // lock already gone
    emitContractLockUnlinkFailed(
      ctx.audit,
      {
        context: 'ContractSystem.releaseLock',
        path: lockPath,
        reason: 'move_failed',
        error: formatErr(moveErr),
      },
    );
    return;
  }

  // Now read the renamed file to verify it's still ours (no race window between
  // read and move — the move itself is the atomic claim).
  let raw: string;
  try {
    raw = await ctx.fs.read(releasedPath);
  } catch {
    // Can't read the renamed file → ownership unverifiable.
    // Don't overwrite lockPath; releasedPath stays as forensic evidence.
    return;
  }

  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON but we have raw bytes → try no-replace restore.
    // Use writeExclusiveSync (O_EXCL): if lockPath was re-acquired by C,
    // this fails with EEXIST rather than overwriting C's valid lock.
    try {
      ctx.fs.writeExclusiveSync(lockPath, raw);
      await ctx.fs.delete(releasedPath);
    } catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code === 'EEXIST') {
        // C acquired a valid lock → discard our stale copy
        await ctx.fs.delete(releasedPath).catch(() => { /* silent: best-effort discard stale released copy after EEXIST */ });
      }
      // Non-EEXIST I/O error → leave releasedPath as forensic evidence
    }
    return;
  }

  const validation = LockMetadataReleaseSchema.safeParse(rawParsed);
  if (!validation.success || validation.data.pid !== process.pid || validation.data.ownerToken !== ownerToken) {
    // Token/pid mismatch after rename — something is wrong.
    // Try no-replace restore; if lockPath was re-acquired, discard our stale copy.
    try {
      ctx.fs.writeExclusiveSync(lockPath, raw);
      await ctx.fs.delete(releasedPath);
    } catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code === 'EEXIST') {
        // C acquired a valid lock → discard our stale copy
        await ctx.fs.delete(releasedPath).catch(() => { /* silent: best-effort discard stale released copy after EEXIST */ });
      }
      // Non-EEXIST I/O error → leave releasedPath as forensic evidence
    }
    return;
  }

  try {
    await ctx.fs.delete(releasedPath);
  } catch (e) {
    emitContractLockUnlinkFailed(
      ctx.audit,
      {
        context: 'ContractSystem.releaseLock',
        path: releasedPath,
        error: formatErr(e),
      },
    );
  }
}

export interface LockContractResult {
  dir: string;
  lockPath: string;
  ownerToken: string;
  release: () => Promise<void>;
}

/**
 * Contract lock TOCTOU race retry 上限.
 * Derivation: 5 = 经验值 / 1-2 conflict 视为并发竞争、3+ 视为系统问题 / 配
 * LOCK_CONTRACT_RETRY_DELAY_MS=50ms 总 budget ≈ 250ms / 比 LOCK_MAX_RETRIES=20 紧 4×
 * 因 contract lock 是 high-frequency / 短 retry path.
 */
export const LOCK_CONTRACT_MAX_RETRY = 5;

/**
 * Contract lock TOCTOU race retry delay (ms).
 * Derivation: 50ms 是 chokidar settle 一半 / 比 LOCK_RETRY_DELAY_MS (500ms) 短 10× /
 * contract 层 lookup→lock race 在 ms 级 fs 操作内、短 retry 即可化解多并发夹击.
 * 配 LOCK_CONTRACT_MAX_RETRY=5、总 budget ~ 250ms.
 */
const LOCK_CONTRACT_RETRY_DELAY_MS = 50;

/**
 * Atomic lock acquisition with TOCTOU race protection.
 *
 * Protocol:
 *   1. Call contractDirFn to locate dir
 *   2. acquireLock at dir
 *   3. Post-lock re-verify: call contractDirFn again / same dir → return / different → release + retry
 *
 * Retry trigger: concurrent process moved contract after contractDir but before acquireLock.
 */
export async function lockContract(
  ctx: LockContext,
  contractId: ContractId,
  contractDirFn: (id: ContractId) => Promise<string>,
): Promise<LockContractResult> {
  let attempt = 0;
  while (attempt < LOCK_CONTRACT_MAX_RETRY) {
    const dirBefore = await contractDirFn(contractId);
    const lockPath = `${dirBefore}/${contractId}/progress.lock`;
    const ownerToken = await acquireLock(ctx, lockPath);

    let ownershipTransferred = false;
    let dirAfter: string | undefined;
    try {
      dirAfter = await contractDirFn(contractId);
      if (dirAfter === dirBefore) {
        ownershipTransferred = true;
        return {
          dir: dirBefore,
          lockPath,
          ownerToken,
          release: () => releaseLock(ctx, lockPath, ownerToken),
        };
      }

      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_RACE_RETRY,
        `contractId=${contractId}`,
        `attempt=${attempt}`,
        `dirBefore=${dirBefore}`,
        `dirAfter=${dirAfter}`,
      );
    } finally {
      // Only release if ownership was NOT transferred to the caller. Any
      // exception (including from contractDirFn) keeps ownershipTransferred
      // false, so the lock is cleaned up before the error propagates.
      if (!ownershipTransferred) {
        await releaseLock(ctx, lockPath, ownerToken);
      }
    }

    // Race: directory moved between lookup and lock acquisition — retry.
    if (dirAfter !== undefined && dirAfter !== dirBefore) {
      attempt++;
      await new Promise(r => setTimeout(r, LOCK_CONTRACT_RETRY_DELAY_MS / 2 + Math.random() * LOCK_CONTRACT_RETRY_DELAY_MS));
    }
  }

  ctx.audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_RACE_RETRY,
    `contractId=${contractId}`,
    `attempt=${attempt}`,
    `result=exhausted`,
  );
  throw new LockContentionExhaustedError(contractId, LOCK_CONTRACT_MAX_RETRY);
}
