import { getReadyFile, getPidFile, ensureStatusDir } from './paths.js';
import { formatErr } from "../utils/index.js";
import { isAlive as defaultL1IsAlive, getProcessStartTime as defaultGetProcessStartTime, makeProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import type { ProcessManagerContext } from './types.js';
import type { ClawId } from '../identity/index.js';
import type { PidFileContent } from './pid.js';
import { isFileNotFound } from '../fs/index.js';


export async function markReady(ctx: ProcessManagerContext, clawId: ClawId): Promise<void> {
  // phase 688: readyFile 提到 try 外、catch 可 access、emit 加 path forensic col
  const readyFile = getReadyFile(ctx, clawId);
  try {
    await ensureStatusDir(ctx, clawId);
    const startTime = (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(process.pid);
    const payload: PidFileContent = { pid: process.pid, ...(startTime !== undefined ? { startTime } : {}) };
    await ctx.fs.writeAtomic(readyFile, JSON.stringify(payload));
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_WROTE,
      `claw=${clawId}`,
      `pid=${process.pid}`,
      ...(startTime ? [`startTime=${startTime}`] : ['startTime_skipped']),
    );
  } catch (e) {
    // audit failure but don't throw — caller (daemon boot) should continue, ready signal just absent
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_WROTE,
      `claw=${clawId}`,
      `path=${readyFile}`,
      `context=write_failed`,
      `reason=${formatErr(e)}`,
    );
  }
}

export async function markNotReady(ctx: ProcessManagerContext, clawId: ClawId): Promise<void> {
  const readyFile = getReadyFile(ctx, clawId);
  try {
    await ctx.fs.delete(readyFile);
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_REMOVED, `claw=${clawId}`);
  } catch (err) {
    if (isFileNotFound(err)) {
      // benign: marker 不存在 (boot crash before markReady / 已 markNotReady)
      return;
    }
    // phase 684: 加 path forensic col、与同模块 lock.ts:172 LOCKFILE_CLEANUP_FAILED op=delete 对齐
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_REMOVED,
      `claw=${clawId}`,
      `path=${readyFile}`,
      `context=remove_failed`,
      `reason=${formatErr(err)}`,
    );
  }
}

/**
 * Check whether the claw's daemon has marked itself ready and is still the same
 * process the PID file points to. Returns false on any kind of mismatch
 * (stale ready marker, missing files, parse failure).
 *
 * Cross-checks `ready` file pid+startTime against `pid` file to defend against
 * stale ready markers from a prior process recycled into the same PID.
 *
 * @param ctx     Process manager context
 * @param clawId  Target claw
 * @returns       true only when ready marker and PID file agree on identity
 *                and the OS confirms the process is still alive.
 */
export function isReady(ctx: ProcessManagerContext, clawId: ClawId): boolean {
  const readyFile = getReadyFile(ctx, clawId);
  const pidFile = getPidFile(ctx, clawId);
  let readyContent: string;
  let pidContent: string;
  // phase 686: 拆 read try、emit 加 file= + path= forensic col 区分两 file 失败
  try {
    readyContent = ctx.fs.readSync(readyFile);
  } catch (err) {
    if (isFileNotFound(err)) return false;
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_READ_FAILED,
      `claw=${clawId}`,
      `file=ready`,
      `path=${readyFile}`,
      `reason=${formatErr(err)}`,
    );
    return false;
  }
  try {
    pidContent = ctx.fs.readSync(pidFile);
  } catch (err) {
    if (isFileNotFound(err)) return false;
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_READ_FAILED,
      `claw=${clawId}`,
      `file=pid`,
      `path=${pidFile}`,
      `reason=${formatErr(err)}`,
    );
    return false;
  }
  let readyPid: number;
  let readyStartTime: ProcessStartTime | undefined;
  let pidFilePid: number;
  // phase 687: 拆 parse try、emit 加 file= + path= forensic col 区分两 file 失败
  let ready: { pid?: unknown; startTime?: unknown };
  try {
    ready = JSON.parse(readyContent.trim());
  } catch (err) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_PARSE_FAILED,
      `claw=${clawId}`,
      `file=ready`,
      `path=${readyFile}`,
      `reason=${formatErr(err)}`,
    );
    return false;
  }
  let pidData: { pid?: unknown };
  try {
    pidData = JSON.parse(pidContent.trim());
  } catch (err) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_PARSE_FAILED,
      `claw=${clawId}`,
      `file=pid`,
      `path=${pidFile}`,
      `reason=${formatErr(err)}`,
    );
    return false;
  }
  if (typeof ready?.pid !== 'number' || typeof pidData?.pid !== 'number') return false;
  readyPid = ready.pid;
  readyStartTime = typeof ready.startTime === 'string' ? makeProcessStartTime(ready.startTime) : undefined;
  pidFilePid = pidData.pid;
  if (readyPid !== pidFilePid) {
    // stale marker（前进程 PID） → emit audit 兜底 + 视 not ready
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE,
      `claw=${clawId}`,
      `ready_pid=${readyPid}`,
      `pid_file_pid=${pidFilePid}`,
    );
    // r128 C fork C.1: narrow ENOENT only / non-ENOENT audit emit (mirror phase 1032 cleanup.ts)
    ctx.fs.delete(readyFile).catch((e) => {
      if (!isFileNotFound(e)) {
        // phase 685: 加 path forensic col、与 ready.ts:45 (phase 684) + lock.ts:172 同模块对齐
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
          `claw=${clawId}`,
          `path=${readyFile}`,
          `reason=${formatErr(e)}`,
        );
      }
      // ENOENT silent: benign race / next markReady or already gone
    });
    return false;
  }
  try {
    return (ctx.l1IsAlive ?? defaultL1IsAlive)(readyPid, readyStartTime);
  } catch (err) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_ISALIVE_THROW,
      `claw=${clawId}`,
      `ready_pid=${readyPid}`,
      `reason=${formatErr(err)}`,
    );
    return false;
  }
}
