import { getPidFile, ensureStatusDir } from './paths.js';
import type { DaemonDir } from './types.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from "../node-utils/index.js";
import { getProcessStartTime as defaultGetProcessStartTime, makeProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import type { ProcessManagerContext } from './types.js';
import { isFileNotFound } from '../fs/index.js';


export interface PidFileContent {
  pid: number;
  startTime?: ProcessStartTime;
}

function isValidPid(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export type PidReadResult =
  | { status: 'valid'; pid: number; startTime?: ProcessStartTime }
  | { status: 'spawning' }
  | { status: 'missing' }
  | { status: 'io_error'; error: string }
  | { status: 'corrupt'; error: string };

export async function readPid(ctx: ProcessManagerContext, daemonDir: DaemonDir): Promise<PidReadResult> {
  try {
    const pidFile = getPidFile(ctx, daemonDir);
    const content = (await ctx.fs.read(pidFile)).trim();

    if (content === '') {
      return { status: 'missing' };
    }

    // Try JSON first
    try {
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null) {
        const pid = (parsed as { pid?: unknown }).pid;
        if (isValidPid(pid)) {
          return {
            status: 'valid',
            pid,
            startTime:
              typeof (parsed as { startTime?: unknown }).startTime === 'string'
                ? makeProcessStartTime((parsed as { startTime: string }).startTime)
                : undefined,
          };
        }
        if (pid === 0) {
          return { status: 'spawning' };
        }
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_PARSE_FAILED,
          `daemon_dir=${daemonDir}`,
          `reason=invalid_pid_value`,
          `pid=${String(pid)}`,
        );
        return { status: 'corrupt', error: `invalid PID value: ${String(pid)}` };
      }
    } catch {
      /* silent: JSON parse fail, fall through to legacy int parse */
    }

    // Legacy raw int format (phase 1023 PID file format JSON migration)
    const legacyPid = parseInt(content, 10);
    if (isValidPid(legacyPid)) {
      if (/^\d+$/.test(content.trim())) {
        ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_LEGACY_FORMAT, `daemon_dir=${daemonDir}`, `pid=${legacyPid}`);
        return { status: 'valid', pid: legacyPid, startTime: undefined };
      }
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_PARSE_FAILED,
        `daemon_dir=${daemonDir}`,
        `reason=legacy_pid_not_strict_integer`,
        `pid=${legacyPid}`,
      );
      return { status: 'corrupt', error: 'legacy pid not strict integer' };
    }

    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_PARSE_FAILED,
      `daemon_dir=${daemonDir}`,
      `reason=unparseable_pid_content`,
      `content=${content.slice(0, 50)}`,
    );
    return { status: 'corrupt', error: `unparseable pid content: ${content.slice(0, 50)}` };
  } catch (err) {
    if (isFileNotFound(err)) return { status: 'missing' };
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
      `daemon_dir=${daemonDir}`,
      `reason=${formatErr(err)}`,
    );
    return { status: 'io_error', error: formatErr(err) };
  }
}

export async function removePid(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  context = 'remove_pid',
): Promise<boolean> {
  try {
    const pidFile = getPidFile(ctx, daemonDir);
    await ctx.fs.delete(pidFile);
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_OK, `daemon_dir=${daemonDir}`);
    return true;
  } catch (err) {
    if (isFileNotFound(err)) {
      return true;
    }
    // phase 582: 加 context col、与 spawn.ts 内 2 sites (spawn_retry_overwrite / spawn_cleanup)
    // 对齐、forensic 解析能区分 PID_REMOVE_FAILED 触发路径
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_FAILED,
      `daemon_dir=${daemonDir}`,
      `context=${context}`,
      `reason=${formatErr(err)}`,
    );
    return false;
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
  if (stored.status === 'valid' && stored.pid === process.pid) {
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
  if (stored.status !== 'valid') return false;
  if (stored.pid !== expectedPid) return false;
  if (expectedStartTime !== undefined && stored.startTime !== undefined && stored.startTime !== expectedStartTime)
    return false;
  return removePid(ctx, daemonDir);
}
