import { getLockFile } from './paths.js';
import type { DaemonDir } from './types.js';
import * as path from 'path';
import { formatErr } from "../utils/index.js";
import { isAlive as defaultL1IsAlive, getProcessStartTime as defaultGetProcessStartTime, makeProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { LockConflictError, type ProcessManagerContext } from './types.js';
import { isFileNotFound } from '../fs/index.js';



export function readLockPid(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): { pid: number; startTime?: ProcessStartTime } | null {
  // phase 586: lockFile 提到 try 外、let catch path 内的 audit emit 引用
  const lockFile = getLockFile(ctx, daemonDir);
  try {
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
    // Legacy raw int format (phase 1023 lock file format JSON migration、sibling to pid.ts:34 同 audit const 共用)
    const legacyPid = parseInt(content, 10);
    if (Number.isFinite(legacyPid)) {
      ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_LEGACY_FORMAT, `daemon_dir=${daemonDir}`, `pid=${legacyPid}`, `file=lock`);
      return { pid: legacyPid, startTime: undefined };
    }
    return null;
  } catch (err) {
    if (!isFileNotFound(err)) {
      // phase 586: 加 path forensic col、延续 phase 580 PID_READ_FAILED 模式
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_READ_FAILED,
        `daemon_dir=${daemonDir}`,
        `path=${lockFile}`,
        `reason=${formatErr(err)}`,
      );
    }
    return null;
  }
}

export function acquireLock(ctx: ProcessManagerContext, daemonDir: DaemonDir): void {
  const lockFile = getLockFile(ctx, daemonDir);
  ctx.fs.ensureDirSync(path.dirname(lockFile));
  try {
    ctx.fs.writeExclusiveSync(lockFile, JSON.stringify({ pid: process.pid }));
    // phase 584: 加 context=fresh col、与 L101 context=stale_retry 对齐
    // forensic 解析能区分 LOCK_ACQUIRED 的 2 路径 (首次 acquire vs stale 后重试)
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_ACQUIRED, `daemon_dir=${daemonDir}`, `pid=${process.pid}`, `context=fresh`);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const readLockPidFn = ctx.readLockPid ?? ((id: DaemonDir) => readLockPid(ctx, id));
  const holder = readLockPidFn(daemonDir);
  if (holder !== null) {
    const holderStartTime = holder.startTime ?? (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(holder.pid);
    if ((ctx.l1IsAlive ?? defaultL1IsAlive)(holder.pid, holderStartTime)) {
      throw new LockConflictError(
        daemonDir,
        `Another "${daemonDir}" daemon is running (PID: ${holder.pid})`,
      );
    }
    if (holderStartTime === undefined && process.platform === 'win32') {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.STARTTIME_VERIFY_SKIPPED_WINDOWS,
        `daemon_dir=${daemonDir}`,
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
        `daemon_dir=${daemonDir}`,
        `op=acquire_retry`,
        `reason=${formatErr(e)}`,
      );
    }
  }
  try {
    ctx.fs.writeExclusiveSync(lockFile, JSON.stringify({ pid: process.pid }));
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.LOCK_ACQUIRED,
      `daemon_dir=${daemonDir}`,
      `pid=${process.pid}`,
      `context=stale_retry`,
    );
  } catch (retryErr) {
    if ((retryErr as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new LockConflictError(
        daemonDir,
        `Another "${daemonDir}" daemon acquired the lock during retry`,
      );
    }
    throw retryErr;
  }
}

export function releaseLock(ctx: ProcessManagerContext, daemonDir: DaemonDir): void {
  const readLockPidFn = ctx.readLockPid ?? ((id: DaemonDir) => readLockPid(ctx, id));
  const holder = readLockPidFn(daemonDir);
  if (holder === null || holder.pid !== process.pid) return;
  const lockFile = getLockFile(ctx, daemonDir);
  try {
    ctx.fs.deleteSync(lockFile);
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.LOCK_RELEASED, `daemon_dir=${daemonDir}`, `pid=${process.pid}`);
  } catch (err) {
    if (!isFileNotFound(err)) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
        `daemon_dir=${daemonDir}`,
        `op=release`,
        `reason=${formatErr(err)}`,
      );
    }
  }
}
