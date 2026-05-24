import { kill, isAlive as l1IsAlive } from '../process-exec/index.js';
import { DAEMON_SHUTDOWN_GRACE_MS, PROCESS_STOP_POLL_INTERVAL_MS } from './constants.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { readPid, removePid } from './pid.js';
import type { ProcessManagerContext } from './types.js';

export async function stopProcess(ctx: ProcessManagerContext, clawId: string): Promise<boolean> {
  const stored = await readPid(ctx, clawId);
  if (!stored) {
    return false;
  }

  // phase 879：直接 l1IsAlive(pid) authoritative check（pid 已 line 10 拿、不依赖 pidfile probe）
  // 消除 isAliveByPidFile 经 getAliveStatus.readSync(pidFile) → 并发 caller race window
  if (!l1IsAlive(stored.pid, stored.startTime)) {
    await removePid(ctx, clawId);
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_STALE,
      `claw=${clawId}`,
      `pid=${stored.pid}`,
    );
    return true;
  }

  let via = 'sigterm';
  try {
    kill(stored.pid, 'TERM');

    // poll until process exits or timeout (early exit)
    const deadline = Date.now() + DAEMON_SHUTDOWN_GRACE_MS;
    while (Date.now() < deadline) {
      if (!l1IsAlive(stored.pid, stored.startTime)) {
        break; // early exit
      }
      await new Promise(resolve => setTimeout(resolve, PROCESS_STOP_POLL_INTERVAL_MS));
    }

    if (l1IsAlive(stored.pid, stored.startTime)) {
      kill(stored.pid, 'KILL');
      via = 'sigkill';
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_KILL_ESCALATED,
        `claw=${clawId}`,
        `pid=${stored.pid}`,
      );
    }

    await removePid(ctx, clawId);
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOPPED,
      `claw=${clawId}`,
      `pid=${stored.pid}`,
      `via=${via}`,
    );
    return true;
  } catch (err: any) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
      `claw=${clawId}`,
      `pid=${stored.pid}`,
      `via=${via}`,
      `reason=${err.code || err.message}`,
    );
    return false;
  }
}
