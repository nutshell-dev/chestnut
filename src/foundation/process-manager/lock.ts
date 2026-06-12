import { getLockFile } from './paths.js';
import * as path from 'path';
import { formatErr } from "../utils/index.js";
import { isAlive as defaultL1IsAlive, getProcessStartTime as defaultGetProcessStartTime, makeProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { LockConflictError, type ProcessManagerContext } from './types.js';
import { isFileNotFound } from '../fs/types.js';
import type { ClawId } from '../../constants.js';


export function readLockPid(
  ctx: ProcessManagerContext,
  clawId: ClawId,
): { pid: number; startTime?: ProcessStartTime } | null {
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
              ? makeProcessStartTime((parsed as { startTime: string }).startTime)
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
  } catch (err) {
    if (!isFileNotFound(err)) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_READ_FAILED,
        `claw=${clawId}`,
        `reason=${formatErr(err)}`,
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const readLockPidFn = ctx.readLockPid ?? ((id: ClawId) => readLockPid(ctx, id));
  const holder = readLockPidFn(clawId);
  if (holder !== null) {
    const holderStartTime = holder.startTime ?? (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(holder.pid);
    if ((ctx.l1IsAlive ?? defaultL1IsAlive)(holder.pid, holderStartTime)) {
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
  } catch (e) {
    if (!isFileNotFound(e)) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
        `claw=${clawId}`,
        `op=acquire_retry`,
        `reason=${formatErr(e)}`,
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
  } catch (retryErr) {
    if ((retryErr as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new LockConflictError(
        clawId,
        `Another "${clawId}" daemon acquired the lock during retry`,
      );
    }
    throw retryErr;
  }
}

export function releaseLock(ctx: ProcessManagerContext, clawId: ClawId): void {
  const readLockPidFn = ctx.readLockPid ?? ((id: ClawId) => readLockPid(ctx, id));
  const holder = readLockPidFn(clawId);
  if (holder === null || holder.pid !== process.pid) return;
  const lockFile = getLockFile(ctx, clawId);
  try {
    ctx.fs.deleteSync(lockFile);
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_RELEASED, `claw=${clawId}`, `pid=${process.pid}`);
  } catch (err) {
    if (!isFileNotFound(err)) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
        `claw=${clawId}`,
        `op=release`,
        `reason=${formatErr(err)}`,
      );
    }
  }
}
