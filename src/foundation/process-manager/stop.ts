import { kill as defaultKill, isAlive as defaultL1IsAlive } from '../process-exec/index.js';
import type { DaemonDir } from './types.js';
import { DAEMON_SHUTDOWN_GRACE_MS, PROCESS_STOP_POLL_INTERVAL_MS, SIGKILL_DEAD_VERIFY_GRACE_MS } from './constants.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { readPid, removePid } from './pid.js';
import { acquireSpawnLock, releaseSpawnLock } from './lock.js';
import { LockConflictError, type ProcessManagerContext } from './types.js';

// spawn 窗口（{pid:0} → {pid:real}）是 sub-second 级；给 stop 一个有界重试即可，
// 超时 fail-closed（不删状态不明的 pidfile）。
const SPAWNING_LOCK_WAIT_MS = 5000;
const SPAWNING_LOCK_RETRY_BACKOFF_MS = 100;



export async function stopProcess(ctx: ProcessManagerContext, daemonDir: DaemonDir): Promise<boolean> {
  const stored = await readPid(ctx, daemonDir);
  if (stored.status === 'missing') {
    return false;
  }
  if (stored.status === 'spawning') {
    // spawn is writing {pid:0} → {pid:real} under the spawn-transition lock
    // (daemon.lock.spawn — phase 1017, separate from the daemon lifecycle lock).
    // Acquire the same lock to close the window, then re-read. The window is
    // sub-second, so a short bounded retry is enough; on exhaustion fail closed
    // (never delete a pidfile whose state we cannot confirm).
    let acquired = false;
    const deadline = Date.now() + SPAWNING_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        acquireSpawnLock(ctx, daemonDir);
        acquired = true;
        break;
      } catch (err) {
        if (err instanceof LockConflictError) {
          await new Promise(r => setTimeout(r, SPAWNING_LOCK_RETRY_BACKOFF_MS));
          continue;
        }
        throw err;
      }
    }
    if (!acquired) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PID_SPAWNING_LOCK_RETRY,
        `daemon_dir=${daemonDir}`,
        `reason=retries_exhausted`,
      );
      return false;
    }

    let recurse = false;
    let result: boolean | undefined;
    try {
      const recheck = await readPid(ctx, daemonDir);
      if (recheck.status === 'spawning') {
        // spawner died mid-window → remove the stale sentinel while holding the lock
        result = await removePid(ctx, daemonDir, 'stop_spawning_sentinel');
      } else if (recheck.status === 'valid') {
        // PID advanced to a real value → handle via the normal kill path
        recurse = true;
      } else if (recheck.status === 'missing') {
        result = false;
      } else {
        // io_error / corrupt → fail closed
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
          `daemon_dir=${daemonDir}`,
          `reason=pidfile_unreadable_or_corrupt`,
          `detail=${recheck.error}`,
        );
        result = false;
      }
    } finally {
      releaseSpawnLock(ctx, daemonDir);
    }
    if (recurse) {
      return stopProcess(ctx, daemonDir);
    }
    return result ?? false;
  }
  if (stored.status !== 'valid') {
    // io_error or corrupt → fail closed
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
      `daemon_dir=${daemonDir}`,
      `reason=pidfile_unreadable_or_corrupt`,
      `detail=${stored.error}`,
    );
    return false;
  }

  // phase 879：直接 l1IsAlive(pid) authoritative check（pid 已 line 10 拿、不依赖 pidfile probe）
  // 消除 isAliveByPidFile 经 getAliveStatus.readSync(pidFile) → 并发 caller race window
  if (!(ctx.l1IsAlive ?? defaultL1IsAlive)(stored.pid, stored.startTime)) {
    const removed = await removePid(ctx, daemonDir);
    if (!removed) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
        `daemon_dir=${daemonDir}`,
        `pid=${stored.pid}`,
        `reason=pidfile_remove_failed`,
      );
      return false;
    }
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_STALE,
      `daemon_dir=${daemonDir}`,
      `pid=${stored.pid}`,
    );
    return true;
  }

  let via = 'sigterm';
  try {
    (ctx.kill ?? defaultKill)(stored.pid, 'TERM');

    // poll until process exits or timeout (early exit)
    const deadline = Date.now() + DAEMON_SHUTDOWN_GRACE_MS;
    while (Date.now() < deadline) {
      if (!(ctx.l1IsAlive ?? defaultL1IsAlive)(stored.pid, stored.startTime)) {
        break; // early exit
      }
      await new Promise(resolve => setTimeout(resolve, PROCESS_STOP_POLL_INTERVAL_MS));
    }

    if ((ctx.l1IsAlive ?? defaultL1IsAlive)(stored.pid, stored.startTime)) {
      (ctx.kill ?? defaultKill)(stored.pid, 'KILL');
      via = 'sigkill';
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_KILL_ESCALATED,
        `daemon_dir=${daemonDir}`,
        `pid=${stored.pid}`,
      );
      // phase 355 C1 (review-2026-06-13): SIGKILL 是 async（kernel 异步 reap）、
      // 调返时进程未必已死。删 PID 前 verify-loop 等真死、防 isAlive race + spawn
      // 第二实例。超时仍活 → audit 留诊断、仍删（不阻 stop 完成、人介入修）。
      const verifyDeadline = Date.now() + SIGKILL_DEAD_VERIFY_GRACE_MS;
      while (Date.now() < verifyDeadline) {
        if (!(ctx.l1IsAlive ?? defaultL1IsAlive)(stored.pid, stored.startTime)) break;
        await new Promise(resolve => setTimeout(resolve, PROCESS_STOP_POLL_INTERVAL_MS));
      }
      if ((ctx.l1IsAlive ?? defaultL1IsAlive)(stored.pid, stored.startTime)) {
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.STOP_PID_REMOVED_BEFORE_DEAD,
          `daemon_dir=${daemonDir}`,
          `pid=${stored.pid}`,
          `grace_ms=${SIGKILL_DEAD_VERIFY_GRACE_MS}`,
        );
        return false;  // phase 804: SIGKILL 后仍存活 → 不删 PID，让调用方感知失败
      }
    }

    const removed = await removePid(ctx, daemonDir);
    if (!removed) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
        `daemon_dir=${daemonDir}`,
        `pid=${stored.pid}`,
        `reason=pidfile_remove_failed`,
      );
      return false;
    }
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOPPED,
      `daemon_dir=${daemonDir}`,
      `pid=${stored.pid}`,
      `via=${via}`,
    );
    return true;
  } catch (err) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
      `daemon_dir=${daemonDir}`,
      `pid=${stored.pid}`,
      `via=${via}`,
      `reason=${(err as NodeJS.ErrnoException).code || (err as Error).message}`,
    );
    return false;
  }
}
