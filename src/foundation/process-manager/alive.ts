import { getPidFile } from './paths.js';
import type { ClawId } from '../../constants.js';
import { isAlive as defaultL1IsAlive, makeProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import { formatErr } from "../utils/index.js";
import type { ProcessManagerContext } from './types.js';
import { isFileNotFound } from '../fs/types.js';


/**
 * Read the PID file for a claw and return its liveness verdict.
 *
 * Side-effect free probe (M#1): never deletes / repairs a stale pidfile —
 * cleanup is the responsibility of explicit stop/recovery paths.
 *
 * @param ctx       Process manager context (fs + audit + resolveDir)
 * @param clawId    Target claw
 * @returns         `alive`: liveness verdict; `reason`: human-readable cause;
 *                  `pid`: parsed PID when readable (regardless of liveness).
 *                  Unknown exceptions during the OS probe degrade to `alive=true`
 *                  to avoid killing a healthy process (PM-5).
 */
export function getAliveStatus(
  ctx: ProcessManagerContext,
  clawId: ClawId,
): { alive: boolean; reason: string; pid?: number } {
  try {
    const pidFile = getPidFile(ctx, clawId);
    const content = ctx.fs.readSync(pidFile);
    const trimmed = content.trim();
    if (trimmed === '') {
      return { alive: false, reason: 'empty PID file' };
    }

    let pid: number;
    let startTime: ProcessStartTime | undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.pid === 'number') {
        pid = parsed.pid;
        startTime = typeof parsed.startTime === 'string' ? makeProcessStartTime(parsed.startTime) : undefined;
      } else {
        throw new Error('invalid JSON pidfile');
      }
    } catch {
      pid = parseInt(trimmed, 10);
      if (isNaN(pid)) {
        return { alive: false, reason: `invalid PID: "${trimmed}"` };
      }
    }
    // phase 458 (review N3-M): pid=0 sentinel = spawn 进行中、子 PID 未覆盖。
    // 跳过 kill 决策、视为「not alive 但 spawning」、防外部 stop 误杀父进程。
    if (pid === 0) {
      return { alive: false, reason: 'spawning placeholder (pid=0)' };
    }

    try {
      if ((ctx.l1IsAlive ?? defaultL1IsAlive)(pid, startTime)) {
        return { alive: true, reason: `PID ${pid}`, pid };
      }
      // M#1 probe ≠ delete：probe 不 mutate state、stale pidfile 清理归 stop/recovery 显式路径
      // 历史 deleteSync 引发 stop.ts isAliveByPidFile race（new4.P1.1 + new4.P2.1-C 同根 cluster phase 879）
      return { alive: false, reason: `PID ${pid} not alive` };
    } catch (err) {
      // PM-5：非 ESRCH/EPERM 的异常 → 保守假设 alive，避免误杀健康进程
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'EPERM') {
        return { alive: false, reason: `isAlive ${code}` };
      }
      return { alive: true, reason: `isAlive probe failed: ${formatErr(err)}`, pid };
    }
  } catch (err) {
    if (isFileNotFound(err)) {
      return { alive: false, reason: 'no PID file' };
    }
    return { alive: false, reason: `read error: ${(err as NodeJS.ErrnoException).code || (err as Error).message}` };
  }
}

export function isAliveByPidFile(ctx: ProcessManagerContext, clawId: ClawId): boolean {
  return getAliveStatus(ctx, clawId).alive;
}
