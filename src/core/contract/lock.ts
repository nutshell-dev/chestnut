/**
 * @module L4.ContractSystem.Lock
 * Contract progress lock primitives — 函数化 / 0 class state
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import { AUDIT_PREVIEW_LEN } from '../../foundation/audit/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { FileNotFoundError, ToolError } from '../../types/index.js';
import { LOCK_MAX_RETRIES, LOCK_RETRY_DELAY_MS, LOCK_STALE_TIMEOUT_MS } from './constants.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { isAlive } from '../../foundation/process-exec/index.js';

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
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;

      try {
        const raw = await ctx.fs.read(lockPath);
        const parsed = JSON.parse(raw) as { pid?: unknown; time?: unknown };
        // schema 校验：pid + time 必为有限数 / 非法视同 corrupt
        if (
          typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid) ||
          typeof parsed.time !== 'number' || !Number.isFinite(parsed.time)
        ) {
          ctx.audit.write(
            CONTRACT_AUDIT_EVENTS.LOCK_SCHEMA_INVALID,
            `path=${lockPath}`,
            `raw=${raw.slice(0, AUDIT_PREVIEW_LEN)}`,
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
          ctx.audit.write(
            CONTRACT_AUDIT_EVENTS.LOCK_CLEARED,
            `pid=${pid}`,
            `timeout=${LOCK_STALE_TIMEOUT_MS}`,
            'reason=stale',
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
        await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY_MS));
      }
    }
  }
  throw new ToolError(`Failed to acquire lock after ${LOCK_MAX_RETRIES} retries: ${lockPath} (${lastReason})`);
}

export async function unlinkStaleLock(ctx: LockContext, lockPath: string, reason: string): Promise<boolean> {
  try {
    await ctx.fs.delete(lockPath);
    return true;
  } catch (err: any) {
    if (err instanceof FileNotFoundError) return true;
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.LOCK_CLEANUP_FAILED,
      reason,
      err?.code ?? 'unknown',
      err?.message ?? String(err),
    );
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.LOCK_UNLINK_FAILED,
      `reason=${reason}`,
      `error=${err?.message ?? String(err)}`,
    );
    return false;
  }
}

export async function releaseLock(ctx: LockContext, lockPath: string): Promise<void> {
  try {
    await ctx.fs.delete(lockPath);
  } catch (e) {
    ctx.audit.write(CONTRACT_AUDIT_EVENTS.LOCK_UNLINK_FAILED, `context=ContractSystem.releaseLock`, `path=${lockPath}`, `error=${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function withProgressLock<T>(
  ctx: LockContext,
  contractDir: string,
  contractId: string,
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
