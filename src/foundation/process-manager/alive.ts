import { isAlive as l1IsAlive } from '../process-exec/index.js';
import { getPidFile } from './paths.js';
import type { ProcessManagerContext } from './types.js';
import type { ClawId } from '../identity/index.js';


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
    let startTime: string | undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.pid === 'number') {
        pid = parsed.pid;
        startTime = typeof parsed.startTime === 'string' ? parsed.startTime : undefined;
      } else {
        throw new Error('invalid JSON pidfile');
      }
    } catch {
      pid = parseInt(trimmed, 10);
      if (isNaN(pid)) {
        return { alive: false, reason: `invalid PID: "${trimmed}"` };
      }
    }

    try {
      if (l1IsAlive(pid, startTime)) {
        return { alive: true, reason: `PID ${pid}`, pid };
      }
      // M#1 probe ≠ delete：probe 不 mutate state、stale pidfile 清理归 stop/recovery 显式路径
      // 历史 deleteSync 引发 stop.ts isAliveByPidFile race（new4.P1.1 + new4.P2.1-C 同根 cluster phase 879）
      return { alive: false, reason: `PID ${pid} not alive` };
    } catch (err: any) {
      // PM-5：非 ESRCH/EPERM 的异常 → 保守假设 alive，避免误杀健康进程
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'EPERM') {
        return { alive: false, reason: `isAlive ${code}` };
      }
      return { alive: true, reason: `isAlive probe failed: ${err.message ?? String(err)}`, pid };
    }
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'FS_NOT_FOUND') {
      return { alive: false, reason: 'no PID file' };
    }
    return { alive: false, reason: `read error: ${err.code || err.message}` };
  }
}

export function isAliveByPidFile(ctx: ProcessManagerContext, clawId: ClawId): boolean {
  return getAliveStatus(ctx, clawId).alive;
}
