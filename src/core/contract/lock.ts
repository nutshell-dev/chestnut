/**
 * @module L4.ContractSystem.Lock
 * Contract progress lock primitives — 函数化 / 0 class state
 */

import * as path from 'path';
import { z } from 'zod';
import { formatErr, newShortUuid } from "../../foundation/node-utils/index.js";
import type { FileSystem } from '../../foundation/fs/index.js';

import type { AuditLog } from '../../foundation/audit/index.js';
import { FileNotFoundError, isFileNotFound } from '../../foundation/fs/index.js';
import { ToolError } from '../../foundation/tools/errors.js';
import { LOCK_MAX_RETRIES, LOCK_RETRY_DELAY_MS, LOCK_STALE_TIMEOUT_MS } from './constants.js';
import { PROGRESS_LOCK_FILE } from './dirs.js';
import {
  emitContractLockSchemaInvalid,
  emitContractLockCleared,
  emitContractLockUnlinkFailed,
  emitContractLockRetry,
} from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { isAlive as defaultL1IsAlive } from '../../foundation/process-exec/index.js';
import { type ContractId, makeContractId } from './types.js';
import { isolateCorruptedFile } from './_isolation-helper.js';
import { LockContentionExhaustedError } from './errors.js';

// phase 326 Zod SoT (ML#9 优先编译器检查): inline lock metadata schemas
// LockMetadataSchema: acquire 路径、{ pid, time } 必为有限数
// LockMetadataReleaseSchema: release verify 路径、subset (pid only)
const LockMetadataSchema = z.object({
  pid: z.number().finite(),
  time: z.number().finite(),
  ownerToken: z.string(),
}).strict();

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

export async function acquireLock(ctx: LockContext, lockPath: string): Promise<string> {
  await ctx.fs.ensureDir(path.dirname(lockPath));

  const ownerToken = newShortUuid();
  let lastReason = 'unknown';

  // phase 1028: use injected retry constants or fall back to module defaults
  const maxRetries = ctx.lockMaxRetries ?? LOCK_MAX_RETRIES;
  const retryDelayMs = ctx.lockRetryDelayMs ?? LOCK_RETRY_DELAY_MS;

  for (let i = 0; i < maxRetries; i++) {
    try {
      ctx.fs.writeExclusiveSync(
        lockPath,
        JSON.stringify({ pid: process.pid, time: Date.now(), ownerToken }),
      );
      return ownerToken;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;

      try {
        const raw = await ctx.fs.read(lockPath);
        // phase 326 Zod SoT (ML#9 优先编译器检查): pid + time 必为有限数、非法视同 corrupt
        const rawParsed: unknown = JSON.parse(raw);
        const validation = LockMetadataSchema.safeParse(rawParsed);
        if (!validation.success) {
          // Old schema (no ownerToken) or other parse failure.
          // Try to extract pid from the raw data to check liveness.
          const legacyPid = typeof rawParsed === 'object' && rawParsed !== null
            ? (rawParsed as Record<string, unknown>).pid : undefined;
          if (typeof legacyPid === 'number' && (ctx.l1IsAlive ?? defaultL1IsAlive)(legacyPid)) {
            // Old-format lock held by a live process — fail-closed.
            // Don't clean it up; the owner is still running its critical section.
            lastReason = `lock schema invalid but PID ${legacyPid} is alive — cannot determine ownership; lock preserved`;
            continue;
          }
          emitContractLockSchemaInvalid(
            ctx.audit,
            { path: lockPath, raw: ctx.audit.preview(raw) },
          );
          // phase 66: 隔离 corrupt lock 文件、然后继续重试
          const contractDir = path.dirname(lockPath);
          const contractId = path.basename(contractDir);
          const isolated = await isolateCorruptedFile(ctx.fs, ctx.audit, {
            contractId: makeContractId(contractId),
            contractDir,
            filename: PROGRESS_LOCK_FILE,
            reason: 'schema_invalid',
          });
          if (isolated) {
            lastReason = 'lock schema corruption isolated; retrying';
            continue;
          }
          // 隔离失败 → fallback 到 unlink stale lock（像处理 corrupt lock file 一样）
          if (await unlinkStaleLock(ctx, lockPath, 'corrupt_lock_file_schema_invalid')) continue;
          lastReason = 'unlink failed on corrupt lock file after isolation failed';
        }
        const { pid, time } = validation.success ? validation.data : { pid: 0, time: 0 };
        const isAlive = (ctx.l1IsAlive ?? defaultL1IsAlive)(pid);
        const isStale = Date.now() - time > LOCK_STALE_TIMEOUT_MS;
        if (!isAlive && isStale) {
          // Both stale-by-time AND dead-by-signal — safe to clean up.
          lastReason = `holder PID ${pid} is dead and stale`;
          emitContractLockCleared(
            ctx.audit,
            { pid, timeout: LOCK_STALE_TIMEOUT_MS, reason: 'stale_and_dead' },
          );
          if (await unlinkStaleLock(ctx, lockPath, `stale_timeout_pid_${pid}`)) continue;
          lastReason = `unlink failed on stale lock (PID ${pid})`;
        } else if (!isAlive) {
          lastReason = `holder PID ${pid} is dead (stale lock)`;
          if (await unlinkStaleLock(ctx, lockPath, `stale_pid_${pid}`)) continue;
          lastReason = `unlink failed on stale lock (PID ${pid})`;
        } else if (isStale) {
          // Stale by time but PID is alive — the lock is still valid.
          // Don't clear it. The process may be slow but not dead.
          lastReason = `holder PID ${pid} exceeded timeout (${LOCK_STALE_TIMEOUT_MS}ms) but is alive — lock preserved`;
        } else {
          lastReason = `held by PID ${pid} (${Math.round((Date.now() - time) / 1000)}s)`;
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          // Non-JSON lock file content — treat as corrupt and attempt cleanup
          // (legacy behavior preserved; we can confirm the file is not a valid
          // lock and therefore not owned by a live process).
          lastReason = 'lock file corrupt or unreadable';
          if (await unlinkStaleLock(ctx, lockPath, 'corrupt_lock_file')) continue;
          lastReason = 'unlink failed on corrupt lock file';
        } else {
          // Unknown errors (I/O, l1IsAlive failure) → fail-closed.
          // Cannot determine if the holder is dead — don't delete the lock.
          emitContractLockUnlinkFailed(ctx.audit, {
            context: 'acquireLock_stale_check',
            path: lockPath,
            reason: 'unknown_error_cannot_determine_staleness',
            error: formatErr(err),
          });
          throw err;
        }
      }

      if (i < maxRetries - 1) {
        // jitter range [T/2, 1.5T] / 0 NEW magic / uses only existing LOCK_RETRY_DELAY_MS
        // (per phase 1317 user ratify「魔法数字不接受」/ dispatch α exp backoff + cap 5s REFRAMED)
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
  }
  throw new ToolError(`Failed to acquire lock after ${maxRetries} retries: ${lockPath} (${lastReason})`);
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
  try {
    const raw = await ctx.fs.read(releasedPath);
    const rawParsed: unknown = JSON.parse(raw);
    const validation = LockMetadataReleaseSchema.safeParse(rawParsed);
    if (!validation.success || validation.data.pid !== process.pid || validation.data.ownerToken !== ownerToken) {
      // Token/pid mismatch after rename — something is wrong. Restore the lock.
      await ctx.fs.move(releasedPath, lockPath).catch(() => { /* silent: best-effort cleanup */ });
      return;
    }
  } catch {
    // Can't read or parse the renamed file → ownership unverifiable. Restore the
    // lock rather than deleting data we cannot confirm belongs to us.
    await ctx.fs.move(releasedPath, lockPath).catch(() => { /* silent: best-effort cleanup */ });
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
