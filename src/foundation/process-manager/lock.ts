import { getLockFile } from './paths.js';
import type { DaemonDir } from './types.js';
import * as path from 'path';
import { formatErr } from "../node-utils/index.js";
import { isAlive as defaultL1IsAlive, getProcessStartTime as defaultGetProcessStartTime, makeProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { LockConflictError, type ProcessManagerContext } from './types.js';
import { isFileNotFound } from '../fs/index.js';



function isValidPid(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export type LockReadResult =
  | { status: 'missing' }
  | { status: 'valid'; holder: { pid: number; startTime?: ProcessStartTime } }
  | { status: 'corrupt'; error: string }
  | { status: 'io_error'; error: string };

export function readLock(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): LockReadResult {
  const lockFile = getLockFile(ctx, daemonDir);
  try {
    const content = ctx.fs.readSync(lockFile).trim();
    if (content === '') {
      return { status: 'missing' };
    }
    // Try JSON first (same format as PID file)
    try {
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null) {
        const pid = (parsed as { pid?: unknown }).pid;
        if (isValidPid(pid)) {
          return {
            status: 'valid',
            holder: {
              pid,
              startTime:
                typeof (parsed as { startTime?: unknown }).startTime === 'string'
                  ? makeProcessStartTime((parsed as { startTime: string }).startTime)
                  : undefined,
            },
          };
        }
      }
    } catch {
      /* silent: JSON parse fail, fall through to legacy int parse */
    }
    // Legacy raw int format (phase 1023 lock file format JSON migration、sibling to pid.ts:34 同 audit const 共用)
    const legacyPid = parseInt(content, 10);
    if (isValidPid(legacyPid)) {
      if (/^\d+$/.test(content.trim())) {
        ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_LEGACY_FORMAT, `daemon_dir=${daemonDir}`, `pid=${legacyPid}`, `file=lock`);
        return { status: 'valid', holder: { pid: legacyPid, startTime: undefined } };
      }
      return { status: 'corrupt', error: 'legacy lock pid not strict integer' };
    }
    return { status: 'corrupt', error: `unparseable lock content: ${content.slice(0, 50)}` };
  } catch (err) {
    if (isFileNotFound(err)) return { status: 'missing' };
    // phase 586: 加 path forensic col、延续 phase 580 PID_READ_FAILED 模式
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_READ_FAILED,
      `daemon_dir=${daemonDir}`,
      `path=${lockFile}`,
      `reason=${formatErr(err)}`,
    );
    return { status: 'io_error', error: formatErr(err) };
  }
}

export function readLockPid(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): { pid: number; startTime?: ProcessStartTime } | null {
  const result = readLock(ctx, daemonDir);
  if (result.status === 'valid') return result.holder;
  return null;
}

export function acquireLock(ctx: ProcessManagerContext, daemonDir: DaemonDir): void {
  const lockFile = getLockFile(ctx, daemonDir);
  ctx.fs.ensureDirSync(path.dirname(lockFile));
  try {
    const startTime = (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(process.pid);
    ctx.fs.writeExclusiveSync(lockFile, JSON.stringify({
      pid: process.pid,
      ...(startTime !== undefined ? { startTime } : {}),
    }));
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
    const retryStartTime = (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(process.pid);
    ctx.fs.writeExclusiveSync(lockFile, JSON.stringify({
      pid: process.pid,
      ...(retryStartTime !== undefined ? { startTime: retryStartTime } : {}),
    }));
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
