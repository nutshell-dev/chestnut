import * as path from 'path';
import { isAlive as l1IsAlive } from '../process-exec/index.js';
import { getProcessStartTime } from '../process-exec/process-starttime.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { getLockFile } from './paths.js';
import { LockConflictError, type ProcessManagerContext } from './types.js';
import { makeClawId, type ClawId } from '../identity/index.js';


export function readLockPid(
  ctx: ProcessManagerContext,
  clawId: ClawId,
): { pid: number; startTime?: string } | null {
  try {
    const lockFile = getLockFile(ctx, clawId);
    const content = ctx.fs.readSync(lockFile).trim();
    // Try JSON first (same format as PID file)
    try {
      const parsed: unknown = JSON.parse(content);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { pid?: unknown }).pid === 'number'
      ) {
        return {
          pid: (parsed as { pid: number }).pid,
          startTime:
            typeof (parsed as { startTime?: unknown }).startTime === 'string'
              ? (parsed as { startTime: string }).startTime
              : undefined,
        };
      }
    } catch {
      /* silent: JSON parse fail, fall through to legacy int parse */
    }
    // Legacy raw int format (phase 1023 lock file format JSON migration / SUNSET per phase 1180: sibling to pid.ts:34 / 同 audit const 共用)
    const legacyPid = parseInt(content, 10);
    if (Number.isFinite(legacyPid)) {
      ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_LEGACY_FORMAT, `claw=${clawId}`, `pid=${legacyPid}`, `file=lock`);
      return { pid: legacyPid, startTime: undefined };
    }
    return null;
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && err?.code !== 'FS_NOT_FOUND') {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_READ_FAILED,
        `claw=${clawId}`,
        `reason=${err?.message || String(err)}`,
      );
    }
    return null;
  }
}

export function acquireLock(ctx: ProcessManagerContext, clawId: ClawId): void {
  const lockFile = getLockFile(ctx, clawId);
  ctx.fs.ensureDirSync(path.dirname(lockFile));
  try {
    ctx.fs.writeExclusiveSync(lockFile, String(process.pid));
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_ACQUIRED, `claw=${clawId}`, `pid=${process.pid}`);
    return;
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }

  const readLockPidFn = ctx.readLockPid ?? ((id: string) => readLockPid(ctx, makeClawId(id)));
  const holder = readLockPidFn(clawId);
  if (holder !== null) {
    const holderStartTime = holder.startTime ?? getProcessStartTime(holder.pid);
    if (l1IsAlive(holder.pid, holderStartTime)) {
      throw new LockConflictError(
        clawId,
        `Another "${clawId}" daemon is running (PID: ${holder.pid})`,
      );
    }
    if (holderStartTime === undefined && process.platform === 'win32') {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.STARTTIME_VERIFY_SKIPPED_WINDOWS,
        `claw=${clawId}`,
        `pid=${holder.pid}`,
      );
    }
  }

  try {
    ctx.fs.deleteSync(lockFile);
  } catch (e: any) {
    if (e?.code !== 'ENOENT' && e?.code !== 'FS_NOT_FOUND') {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
        `claw=${clawId}`,
        `op=acquire_retry`,
        `reason=${e?.message || String(e)}`,
      );
    }
  }
  try {
    ctx.fs.writeExclusiveSync(lockFile, String(process.pid));
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.LOCK_ACQUIRED,
      `claw=${clawId}`,
      `pid=${process.pid}`,
      `context=stale_retry`,
    );
  } catch (retryErr: any) {
    if (retryErr?.code === 'EEXIST') {
      throw new LockConflictError(
        clawId,
        `Another "${clawId}" daemon acquired the lock during retry`,
      );
    }
    throw retryErr;
  }
}

export function releaseLock(ctx: ProcessManagerContext, clawId: ClawId): void {
  const readLockPidFn = ctx.readLockPid ?? ((id: string) => readLockPid(ctx, makeClawId(id)));
  const holder = readLockPidFn(clawId);
  if (holder === null || holder.pid !== process.pid) return;
  const lockFile = getLockFile(ctx, clawId);
  try {
    ctx.fs.deleteSync(lockFile);
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_RELEASED, `claw=${clawId}`, `pid=${process.pid}`);
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && err?.code !== 'FS_NOT_FOUND') {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
        `claw=${clawId}`,
        `op=release`,
        `reason=${err?.message || String(err)}`,
      );
    }
  }
}
