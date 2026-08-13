import type { DaemonDir } from './types.js';
import { isAlive as defaultL1IsAlive, makeProcessStartTime } from '../process-exec/index.js';
import { formatErr } from '../node-utils/index.js';
import type { ProcessManagerContext } from './types.js';
import { inspectActive, inspectActivePid } from './generation.js';

/**
 * Read the active generation PID and return its liveness verdict.
 *
 * Phase 1204 Step E：active/pid.json 是唯一 SoT；legacy status/pid 已删除。
 */
export function getAliveStatus(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): { alive: boolean; reason: string; pid?: number } {
  const active = inspectActive(ctx, daemonDir);
  if (active.status === 'malformed') {
    return { alive: false, reason: `malformed active generation: ${formatErr(active.cause)}` };
  }
  if (active.status === 'none') {
    return { alive: false, reason: 'no active generation' };
  }

  const pid = inspectActivePid(ctx, daemonDir);
  if (pid.status === 'malformed') {
    return { alive: false, reason: `malformed active pid: ${formatErr(pid.cause)}` };
  }
  if (pid.status === 'none') {
    return { alive: false, reason: 'active generation without pid fact' };
  }

  if (pid.record.generation_id !== active.record.generation_id) {
    return { alive: false, reason: 'active pid generation mismatch' };
  }

  try {
    if (
      (ctx.l1IsAlive ?? defaultL1IsAlive)(
        pid.record.pid,
        pid.record.start_time !== undefined
          ? makeProcessStartTime(pid.record.start_time)
          : undefined,
      )
    ) {
      return { alive: true, reason: `PID ${pid.record.pid}`, pid: pid.record.pid };
    }
    return { alive: false, reason: `PID ${pid.record.pid} not alive`, pid: pid.record.pid };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return { alive: false, reason: 'isAlive ESRCH', pid: pid.record.pid };
    }
    if (code === 'EPERM') {
      return { alive: true, reason: `isAlive EPERM (process exists, cannot probe)`, pid: pid.record.pid };
    }
    return { alive: true, reason: `isAlive probe failed: ${formatErr(err)}`, pid: pid.record.pid };
  }
}
