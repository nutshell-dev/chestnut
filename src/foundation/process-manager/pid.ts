import { getPidFile, ensureStatusDir } from './paths.js';
import type { DaemonDir } from './types.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from "../utils/index.js";
import { getProcessStartTime as defaultGetProcessStartTime, makeProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import type { ProcessManagerContext } from './types.js';
import { isFileNotFound } from '../fs/index.js';


export interface PidFileContent {
  pid: number;
  startTime?: ProcessStartTime;
}

export async function readPid(ctx: ProcessManagerContext, daemonDir: DaemonDir): Promise<PidFileContent | null> {
  try {
    const pidFile = getPidFile(ctx, daemonDir);
    const content = (await ctx.fs.read(pidFile)).trim();
    // Try JSON first
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
    // Legacy raw int format (phase 1023 PID file format JSON migration)
    const legacyPid = parseInt(content, 10);
    if (Number.isFinite(legacyPid)) {
      ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_LEGACY_FORMAT, `daemon_dir=${daemonDir}`, `pid=${legacyPid}`);
      return { pid: legacyPid, startTime: undefined };
    }
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_PARSE_FAILED, `daemon_dir=${daemonDir}`);
    return null;
  } catch (err) {
    if (isFileNotFound(err)) return null;
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
      `daemon_dir=${daemonDir}`,
      `reason=${formatErr(err)}`,
    );
    return null;
  }
}

export async function removePid(ctx: ProcessManagerContext, daemonDir: DaemonDir): Promise<void> {
  try {
    const pidFile = getPidFile(ctx, daemonDir);
    await ctx.fs.delete(pidFile);
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_OK, `daemon_dir=${daemonDir}`);
  } catch (err) {
    if (isFileNotFound(err)) {
      return;
    }
    // phase 582: 加 context col、与 spawn.ts 内 2 sites (spawn_retry_overwrite / spawn_cleanup)
    // 对齐、forensic 解析能区分 PID_REMOVE_FAILED 触发路径
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_FAILED,
      `daemon_dir=${daemonDir}`,
      `context=remove_pid`,
      `reason=${formatErr(err)}`,
    );
  }
}

export async function selfWritePid(ctx: ProcessManagerContext, daemonDir: DaemonDir): Promise<void> {
  try {
    await ensureStatusDir(ctx, daemonDir);
    const pidFile = getPidFile(ctx, daemonDir);
    const startTime = (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(process.pid);
    const payload: PidFileContent = { pid: process.pid, ...(startTime !== undefined ? { startTime } : {}) };
    await ctx.fs.writeAtomic(pidFile, JSON.stringify(payload));
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_OK,
      `daemon_dir=${daemonDir}`,
      `pid=${process.pid}`,
      ...(startTime ? [`startTime=${startTime}`] : ['startTime_skipped']),
    );
  } catch (e) {
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_FAILED, `daemon_dir=${daemonDir}`, `reason=${formatErr(e)}`);
    throw e;
  }
}

export async function selfRemovePid(ctx: ProcessManagerContext, daemonDir: DaemonDir): Promise<void> {
  const stored = await readPid(ctx, daemonDir);
  if (stored !== null && stored.pid === process.pid) {
    await removePid(ctx, daemonDir);
  }
}

export async function removePidIfMatch(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  expectedPid: number,
  expectedStartTime?: ProcessStartTime,
): Promise<boolean> {
  const stored = await readPid(ctx, daemonDir);
  if (stored === null) return false;
  if (stored.pid !== expectedPid) return false;
  if (expectedStartTime !== undefined && stored.startTime !== undefined && stored.startTime !== expectedStartTime)
    return false;
  await removePid(ctx, daemonDir);
  return true;
}
