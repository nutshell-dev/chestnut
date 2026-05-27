import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { getPidFile, ensureStatusDir } from './paths.js';
import { getProcessStartTime } from '../process-exec/process-starttime.js';
import type { ProcessManagerContext } from './types.js';
import type { ClawId } from '../identity/index.js';


export interface PidFileContent {
  pid: number;
  startTime?: string;
}

export async function readPid(ctx: ProcessManagerContext, clawId: ClawId): Promise<PidFileContent | null> {
  try {
    const pidFile = getPidFile(ctx, clawId);
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
              ? (parsed as { startTime: string }).startTime
              : undefined,
        };
      }
    } catch {
      /* silent: JSON parse fail, fall through to legacy int parse */
    }
    // Legacy raw int format (phase 1023 PID file format JSON migration / SUNSET per phase 1180: 30 天 audit PID_FILE_LEGACY_FORMAT 0 触发 → r130+ phase 删本 fallback)
    const legacyPid = parseInt(content, 10);
    if (Number.isFinite(legacyPid)) {
      ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_LEGACY_FORMAT, `claw=${clawId}`, `pid=${legacyPid}`);
      return { pid: legacyPid, startTime: undefined };
    }
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_FILE_PARSE_FAILED, `claw=${clawId}`);
    return null;
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'FS_NOT_FOUND') return null;
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
      `claw=${clawId}`,
      `reason=${err?.message || String(err)}`,
    );
    return null;
  }
}

export async function removePid(ctx: ProcessManagerContext, clawId: ClawId): Promise<void> {
  try {
    const pidFile = getPidFile(ctx, clawId);
    await ctx.fs.delete(pidFile);
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_OK, `claw=${clawId}`);
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'FS_NOT_FOUND') {
      return;
    }
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_FAILED,
      `claw=${clawId}`,
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function selfWritePid(ctx: ProcessManagerContext, clawId: ClawId): Promise<void> {
  try {
    await ensureStatusDir(ctx, clawId);
    const pidFile = getPidFile(ctx, clawId);
    const startTime = getProcessStartTime(process.pid);
    const payload: PidFileContent = { pid: process.pid, ...(startTime !== undefined ? { startTime } : {}) };
    await ctx.fs.writeAtomic(pidFile, JSON.stringify(payload));
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_OK,
      `claw=${clawId}`,
      `pid=${process.pid}`,
      ...(startTime ? [`startTime=${startTime}`] : ['startTime_skipped']),
    );
  } catch (e: any) {
    ctx.audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PID_WRITE_FAILED, `claw=${clawId}`, `reason=${e?.message ?? String(e)}`);
    throw e;
  }
}

export async function selfRemovePid(ctx: ProcessManagerContext, clawId: ClawId): Promise<void> {
  const stored = await readPid(ctx, clawId);
  if (stored !== null && stored.pid === process.pid) {
    await removePid(ctx, clawId);
  }
}

export async function removePidIfMatch(
  ctx: ProcessManagerContext,
  clawId: ClawId,
  expectedPid: number,
  expectedStartTime?: string,
): Promise<boolean> {
  const stored = await readPid(ctx, clawId);
  if (stored === null) return false;
  if (stored.pid !== expectedPid) return false;
  if (expectedStartTime !== undefined && stored.startTime !== undefined && stored.startTime !== expectedStartTime)
    return false;
  await removePid(ctx, clawId);
  return true;
}
