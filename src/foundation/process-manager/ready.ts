import { getReadyFile, getPidFile, ensureStatusDir } from './paths.js';
import { isAlive as l1IsAlive } from '../process-exec/index.js';
import { getProcessStartTime } from '../process-exec/process-starttime.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import type { ProcessManagerContext } from './types.js';
import type { PidFileContent } from './pid.js';
import { isFileNotFound } from '../fs/types.js';
import type { ClawId } from '../identity/index.js';


export async function markReady(ctx: ProcessManagerContext, clawId: ClawId): Promise<void> {
  try {
    await ensureStatusDir(ctx, clawId);
    const readyFile = getReadyFile(ctx, clawId);
    const startTime = getProcessStartTime(process.pid);
    const payload: PidFileContent = { pid: process.pid, ...(startTime !== undefined ? { startTime } : {}) };
    await ctx.fs.writeAtomic(readyFile, JSON.stringify(payload));
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_WROTE,
      `claw=${clawId}`,
      `pid=${process.pid}`,
      ...(startTime ? [`startTime=${startTime}`] : ['startTime_skipped']),
    );
  } catch (e: any) {
    // audit failure but don't throw — caller (daemon boot) should continue, ready signal just absent
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_WROTE,
      `claw=${clawId}`,
      `context=write_failed`,
      `reason=${e?.message ?? String(e)}`,
    );
  }
}

export async function markNotReady(ctx: ProcessManagerContext, clawId: ClawId): Promise<void> {
  const readyFile = getReadyFile(ctx, clawId);
  try {
    await ctx.fs.delete(readyFile);
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_REMOVED, `claw=${clawId}`);
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'FS_NOT_FOUND') {
      // benign: marker 不存在 (boot crash before markReady / 已 markNotReady)
      return;
    }
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_REMOVED,
      `claw=${clawId}`,
      `context=remove_failed`,
      `reason=${err?.message ?? String(err)}`,
    );
  }
}

export function isReady(ctx: ProcessManagerContext, clawId: ClawId): boolean {
  const readyFile = getReadyFile(ctx, clawId);
  const pidFile = getPidFile(ctx, clawId);
  let readyContent: string;
  let pidContent: string;
  try {
    readyContent = ctx.fs.readSync(readyFile);
    pidContent = ctx.fs.readSync(pidFile);
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'FS_NOT_FOUND') {
      return false; // 任一缺则 not ready (normal)
    }
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_READ_FAILED,
      `claw=${clawId}`,
      `reason=${err?.message ?? String(err)}`,
    );
    return false;
  }
  let readyPid: number;
  let readyStartTime: string | undefined;
  let pidFilePid: number;
  try {
    const ready = JSON.parse(readyContent.trim());
    const pidData = JSON.parse(pidContent.trim());
    if (typeof ready?.pid !== 'number' || typeof pidData?.pid !== 'number') return false;
    readyPid = ready.pid;
    readyStartTime = typeof ready.startTime === 'string' ? ready.startTime : undefined;
    pidFilePid = pidData.pid;
  } catch (err: any) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_PARSE_FAILED,
      `claw=${clawId}`,
      `reason=${err?.message ?? String(err)}`,
    );
    return false; // schema 不符 / legacy raw int (虽 readyMarker 永远写 JSON) → 视 not ready
  }
  if (readyPid !== pidFilePid) {
    // stale marker（前进程 PID） → emit audit 兜底 + 视 not ready
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE,
      `claw=${clawId}`,
      `ready_pid=${readyPid}`,
      `pid_file_pid=${pidFilePid}`,
    );
    // r128 C fork C.1: narrow ENOENT only / non-ENOENT audit emit (mirror phase 1032 cleanup.ts)
    ctx.fs.delete(readyFile).catch((e: any) => {
      if (!isFileNotFound(e)) {
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.READY_STALE_CLEANUP_FAILED,
          `claw=${clawId}`,
          `reason=${e?.message ?? String(e)}`,
        );
      }
      // ENOENT silent: benign race / next markReady or already gone
    });
    return false;
  }
  try {
    return l1IsAlive(readyPid, readyStartTime);
  } catch (err: any) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.READY_CHECK_ISALIVE_THROW,
      `claw=${clawId}`,
      `ready_pid=${readyPid}`,
      `reason=${err?.message ?? String(err)}`,
    );
    return false;
  }
}
