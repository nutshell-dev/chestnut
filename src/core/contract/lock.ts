/**
 * @module L4.ContractSystem.Lock
 * Contract progress lock primitives — 函数化 / 0 class state
 */

import * as path from 'path';
import { z } from 'zod';
import { formatErr } from "../../foundation/node-utils/index.js";
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
}).strict();

const LockMetadataReleaseSchema = z.object({
  pid: z.number().finite(),
});

export interface LockContext {
  fs: FileSystem;
  audit: AuditLog;
  l1IsAlive?: typeof defaultL1IsAlive;
}

export async function acquireLock(ctx: LockContext, lockPath: string): Promise<void> {
  await ctx.fs.ensureDir(path.dirname(lockPath));

  let lastReason = 'unknown';

  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      ctx.fs.writeExclusiveSync(
        lockPath,
        JSON.stringify({ pid: process.pid, time: Date.now() }),
      );
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;

      try {
        const raw = await ctx.fs.read(lockPath);
        // phase 326 Zod SoT (ML#9 优先编译器检查): pid + time 必为有限数、非法视同 corrupt
        const rawParsed: unknown = JSON.parse(raw);
        const validation = LockMetadataSchema.safeParse(rawParsed);
        if (!validation.success) {
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
        if (!(ctx.l1IsAlive ?? defaultL1IsAlive)(pid)) {
          lastReason = `holder PID ${pid} is dead (stale lock)`;
          if (await unlinkStaleLock(ctx, lockPath, `stale_pid_${pid}`)) continue;
          lastReason = `unlink failed on stale lock (PID ${pid})`;
        } else if (Date.now() - time > LOCK_STALE_TIMEOUT_MS) {
          lastReason = `holder PID ${pid} exceeded timeout (${LOCK_STALE_TIMEOUT_MS}ms)`;
          emitContractLockCleared(
            ctx.audit,
            { pid, timeout: LOCK_STALE_TIMEOUT_MS, reason: 'stale' },
          );
          if (await unlinkStaleLock(ctx, lockPath, `timeout_pid_${pid}`)) continue;
          lastReason = `unlink failed on timeout lock (PID ${pid})`;
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

      if (i < LOCK_MAX_RETRIES - 1) {
        // jitter range [T/2, 1.5T] / 0 NEW magic / uses only existing LOCK_RETRY_DELAY_MS
        // (per phase 1317 user ratify「魔法数字不接受」/ dispatch α exp backoff + cap 5s REFRAMED)
        const delayMs = LOCK_RETRY_DELAY_MS / 2 + Math.random() * LOCK_RETRY_DELAY_MS;
        emitContractLockRetry(ctx.audit, {
          attempt: i + 1,
          max_retries: LOCK_MAX_RETRIES,
          reason: lastReason,
          delay_ms: Math.round(delayMs),
        });
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw new ToolError(`Failed to acquire lock after ${LOCK_MAX_RETRIES} retries: ${lockPath} (${lastReason})`);
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

export async function releaseLock(ctx: LockContext, lockPath: string): Promise<void> {
  try {
    // phase 1102 con-3: verify ownership before deleting to prevent race-condition
    // where a concurrent force-clear removed our lock and replaced it with another
    const raw = await ctx.fs.read(lockPath);
    // phase 953: ownership verification — any read/parse/schema error means we
    // cannot confirm this lock belongs to us, so we must not delete it.
    const rawParsed: unknown = JSON.parse(raw);
    const validation = LockMetadataReleaseSchema.safeParse(rawParsed);
    if (!validation.success) {
      emitContractLockUnlinkFailed(
        ctx.audit,
        {
          context: 'ContractSystem.releaseLock',
          path: lockPath,
          reason: 'ownership_unverifiable',
          error: validation.error.message,
        },
      );
      return;
    }
    if (validation.data.pid !== process.pid) {
      emitContractLockUnlinkFailed(
        ctx.audit,
        {
          context: 'ContractSystem.releaseLock',
          path: lockPath,
          reason: 'ownership_mismatch',
          expectedPid: process.pid,
          actualPid: validation.data.pid,
        },
      );
      return;
    }
  } catch (e) {
    if (isFileNotFound(e)) {
      // Lock already gone — proceed to delete for cleanup so the original audit
      // behavior is preserved (caller may rely on LOCK_UNLINK_FAILED when target
      // lock was never created).
    } else {
      // Read/parse/schema error — cannot verify ownership. Do NOT delete the
      // lock; it may belong to another process.
      emitContractLockUnlinkFailed(
        ctx.audit,
        {
          context: 'ContractSystem.releaseLock',
          path: lockPath,
          reason: 'ownership_unverifiable',
          error: formatErr(e),
        },
      );
      return;
    }
  }

  try {
    await ctx.fs.delete(lockPath);
  } catch (e) {
    emitContractLockUnlinkFailed(
      ctx.audit,
      {
        context: 'ContractSystem.releaseLock',
        path: lockPath,
        error: formatErr(e),
      },
    );
  }
}

export interface LockContractResult {
  dir: string;
  lockPath: string;
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
    await acquireLock(ctx, lockPath);

    let ownershipTransferred = false;
    let dirAfter: string | undefined;
    try {
      dirAfter = await contractDirFn(contractId);
      if (dirAfter === dirBefore) {
        ownershipTransferred = true;
        return {
          dir: dirBefore,
          lockPath,
          release: () => releaseLock(ctx, lockPath),
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
        await releaseLock(ctx, lockPath);
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
