import * as path from 'path';
import { isAlive as l1IsAlive } from '../process-exec/index.js';
import { getProcessStartTime } from '../process-exec/process-starttime.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { getLockFile } from './paths.js';
import { LockConflictError, type ProcessManagerContext } from './types.js';

export function readLockPid(ctx: ProcessManagerContext, clawId: string): number | null {
  try {
    const lockFile = getLockFile(ctx, clawId);
    const content = ctx.fs.readSync(lockFile).trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
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

export function acquireLock(ctx: ProcessManagerContext, clawId: string): void {
  const lockFile = getLockFile(ctx, clawId);
  ctx.fs.ensureDirSync(path.dirname(lockFile));
  try {
    ctx.fs.writeExclusiveSync(lockFile, String(process.pid));
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_ACQUIRED, `claw=${clawId}`, `pid=${process.pid}`);
    return;
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }

  const readLockPidFn = ctx.readLockPid ?? ((id: string) => readLockPid(ctx, id));
  const holderPid = readLockPidFn(clawId);
  if (holderPid !== null) {
    const holderStartTime = getProcessStartTime(holderPid);
    if (l1IsAlive(holderPid, holderStartTime)) {
      throw new LockConflictError(
        clawId,
        `Another "${clawId}" daemon is running (PID: ${holderPid})`,
      );
    }
    if (holderStartTime === undefined && process.platform === 'win32') {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.STARTTIME_VERIFY_SKIPPED_WINDOWS,
        `claw=${clawId}`,
        `pid=${holderPid}`,
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

export function releaseLock(ctx: ProcessManagerContext, clawId: string): void {
  const readLockPidFn = ctx.readLockPid ?? ((id: string) => readLockPid(ctx, id));
  const holderPid = readLockPidFn(clawId);
  if (holderPid !== process.pid) return;
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
