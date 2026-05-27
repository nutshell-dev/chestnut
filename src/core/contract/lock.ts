/**
 * @module L4.ContractSystem.Lock
 * Contract progress lock primitives — 函数化 / 0 class state
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import { AUDIT_PREVIEW_LEN } from '../../foundation/constants.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { FileNotFoundError } from '../../foundation/fs/types.js';
import { ToolError } from '../../foundation/errors.js';
import { LOCK_MAX_RETRIES, LOCK_RETRY_DELAY_MS, LOCK_STALE_TIMEOUT_MS } from './constants.js';
import {
  emitContractLockSchemaInvalid,
  emitContractLockCleared,
  emitContractLockCleanupFailed,
  emitContractLockUnlinkFailed,
  emitContractLockRetry,
} from './audit-emit.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { isAlive } from '../../foundation/process-exec/index.js';
import type { ContractId } from './types.js';


export interface LockContext {
  fs: FileSystem;
  audit: AuditLog;
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
        const parsed = JSON.parse(raw) as { pid?: unknown; time?: unknown };
        // schema 校验：pid + time 必为有限数 / 非法视同 corrupt
        if (
          typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid) ||
          typeof parsed.time !== 'number' || !Number.isFinite(parsed.time)
        ) {
          emitContractLockSchemaInvalid(
            ctx.audit,
            { path: lockPath, raw: raw.slice(0, AUDIT_PREVIEW_LEN) },
          );
          throw new Error('lock schema invalid');
        }
        const { pid, time } = parsed as { pid: number; time: number };
        if (!isAlive(pid)) {
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
      } catch {
        lastReason = 'lock file corrupt or unreadable';
        if (await unlinkStaleLock(ctx, lockPath, 'corrupt_lock_file')) continue;
        lastReason = 'unlink failed on corrupt lock file';
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
    emitContractLockCleanupFailed(
      ctx.audit,
      {
        reason,
        code: (err as NodeJS.ErrnoException)?.code ?? 'unknown',
        error: (err as Error)?.message ?? String(err),
      },
    );
    emitContractLockUnlinkFailed(
      ctx.audit,
      { reason, error: (err as Error)?.message ?? String(err) },
    );
    return false;
  }
}

export async function releaseLock(ctx: LockContext, lockPath: string): Promise<void> {
  try {
    // phase 1102 con-3: verify ownership before deleting to prevent race-condition
    // where a concurrent force-clear removed our lock and replaced it with another
    const raw = await ctx.fs.read(lockPath);
    let parsed: { pid?: unknown } | undefined;
    try {
      parsed = JSON.parse(raw) as { pid?: unknown };
    } catch {
      // silent: backward compat — old-format lock files (plain text / empty) treat as unowned, allow delete
      parsed = undefined;
    }
    if (parsed && typeof parsed.pid === 'number' && parsed.pid !== process.pid) {
      emitContractLockUnlinkFailed(
        ctx.audit,
        {
          context: 'ContractSystem.releaseLock',
          path: lockPath,
          reason: 'ownership_mismatch',
          expectedPid: process.pid,
          actualPid: parsed.pid as number,
        },
      );
      return;
    }
  } catch (e) {
    // ENOENT / FS_NOT_FOUND: proceed to delete so the original audit behavior is preserved
    // (caller may rely on LOCK_UNLINK_FAILED when target lock was never created)
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'FS_NOT_FOUND') {
      // Other read errors: audit and proceed with delete attempt (best-effort)
      emitContractLockUnlinkFailed(
        ctx.audit,
        {
          context: 'ContractSystem.releaseLock',
          path: lockPath,
          reason: 'read_error',
          error: e instanceof Error ? e.message : String(e),
        },
      );
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
        error: e instanceof Error ? e.message : String(e),
      },
    );
  }
}

export async function withProgressLock<T>(
  ctx: LockContext,
  contractDir: string,
  contractId: ContractId,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${contractDir}/${contractId}/progress.lock`;
  await acquireLock(ctx, lockPath);
  try {
    return await fn();
  } finally {
    await releaseLock(ctx, lockPath);
  }
}

export interface LockContractResult {
  dir: string;
  lockPath: string;
  release: () => Promise<void>;
}

const LOCK_CONTRACT_MAX_RETRY = 5;
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

    const dirAfter = await contractDirFn(contractId);
    if (dirAfter === dirBefore) {
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
    await releaseLock(ctx, lockPath);
    attempt++;
    await new Promise(r => setTimeout(r, LOCK_CONTRACT_RETRY_DELAY_MS / 2 + Math.random() * LOCK_CONTRACT_RETRY_DELAY_MS));
  }

  ctx.audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_RACE_RETRY,
    `contractId=${contractId}`,
    `attempt=${attempt}`,
    `result=exhausted`,
  );
  throw new Error(`lockContract: TOCTOU race retry exhausted for ${contractId} after ${LOCK_CONTRACT_MAX_RETRY} attempts`);
}
