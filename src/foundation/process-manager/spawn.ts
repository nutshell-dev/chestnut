import * as path from 'path';
import { spawnDetached, kill } from '../process-exec/index.js';
import { PROCESS_SPAWN_CONFIRM_MS, DAEMON_SHUTDOWN_GRACE_MS, SPAWN_POLL_INTERVAL_MS } from './constants.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { FileNotFoundError } from '../../types/errors.js';
import { ProcessListUnavailable } from './errors.js';
import { ensureStatusDir, getLockFile, getPidFile } from './paths.js';
import { isAliveByPidFile as checkAlive } from './alive.js';
import { readLockPid } from './lock.js';
import { readPid, removePid } from './pid.js';
import { findProcesses } from './find.js';
import { getProcessStartTime } from '../process-exec/process-starttime.js';
import { AUDIT_MESSAGE_MAX_CHARS } from '../audit/index.js';
import { isAlive as l1IsAlive } from '../process-exec/index.js';
import type { ProcessManagerContext, SpawnOptions } from './types.js';

export async function spawnProcess(
  ctx: ProcessManagerContext,
  clawId: string,
  options: SpawnOptions,
): Promise<number> {
  const isAliveByPidFile = ctx.isAlive ?? ((id: string) => checkAlive(ctx, id));
  if (isAliveByPidFile(clawId)) {
    throw new Error(`Claw "${clawId}" is already running (PID file exists)`);
  }

  const pattern = options.args.join(' ');
  let pids: number[] = [];
  try {
    pids = findProcesses(ctx, pattern);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) {
      // 降级：孤儿清理跳过；spawn 继续
    } else {
      throw err;
    }
  }
  let sentAny = false;
  for (const pid of pids) {
    try {
      kill(pid, 'TERM');
      sentAny = true;
    } catch (err: any) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_SIGTERM_FAILED,
        `claw=${clawId}`,
        `pid=${pid}`,
        `reason=${err?.message || String(err)}`,
      );
    }
  }
  if (sentAny) {
    await new Promise(resolve => setTimeout(resolve, DAEMON_SHUTDOWN_GRACE_MS));
  }

  const lockFile = getLockFile(ctx, clawId);
  try {
    const lockPid = readLockPid(ctx, clawId);
    if (lockPid !== null) {
      if (l1IsAlive(lockPid)) {
        try {
          kill(lockPid, 'TERM');
          await new Promise(resolve => setTimeout(resolve, DAEMON_SHUTDOWN_GRACE_MS));
        } catch (err: any) {
          ctx.audit.write(
            PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
            `claw=${clawId}`,
            `op=sigterm`,
            `pid=${lockPid}`,
            `reason=${err?.message || String(err)}`,
          );
        }
      }
    }
    try {
      await ctx.fs.delete(lockFile);
    } catch (err: any) {
      if (err?.code !== 'ENOENT' && err?.code !== 'FS_NOT_FOUND') {
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
          `claw=${clawId}`,
          `op=delete`,
          `path=${lockFile}`,
          `reason=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && err?.code !== 'FS_NOT_FOUND') {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_READ_FAILED,
        `claw=${clawId}`,
        `reason=${err?.code || err?.message || String(err)}`,
      );
    }
  }

  const pidFile = getPidFile(ctx, clawId);
  await ensureStatusDir(ctx, clawId);

  try {
    ctx.fs.writeExclusiveSync(pidFile, '');
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // PID-recycling defense: verify startTime before declaring conflict
      const stored = await readPid(ctx, clawId);
      if (stored !== null) {
        const startTimeForVerify = stored.startTime ?? getProcessStartTime(stored.pid);
        if (l1IsAlive(stored.pid, startTimeForVerify)) {
          throw new Error(`Claw "${clawId}" is already running (PID file exists)`);
        }
        // startTime mismatch or unavailable → fall through to stale cleanup
      }
      // pidfile disappeared during check → fall through to stale cleanup

      let existingContent = '';
      let readSucceeded = false;
      try {
        existingContent = ctx.fs.readSync(pidFile).trim();
        readSucceeded = true;
      } catch (readErr: any) {
        if (readErr?.code === 'ENOENT' || readErr instanceof FileNotFoundError) {
          // race: concurrent removePid deleted pidFile / benign
          ctx.audit.write(
            PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
            `claw=${clawId}`,
            `context=race_check`,
          );
        } else {
          ctx.audit.write(
            PROCESS_MANAGER_AUDIT_EVENTS.PID_READ_FAILED,
            `claw=${clawId}`,
            `context=eexist_check`,
            `reason=${readErr?.message ?? String(readErr)}`,
          );
        }
      }
      if (readSucceeded && existingContent === '') {
        // true empty PID file (concurrent spawn symptom / not race)
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.PID_EMPTY,
          `claw=${clawId}`,
        );
      }
      await removePid(ctx, clawId).catch((err) => {
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_FAILED,
          `claw=${clawId}`,
          `context=spawn_retry_overwrite`,
          `reason=${err instanceof Error ? err.message : String(err)}`,
        );
      });
      ctx.fs.writeExclusiveSync(pidFile, '');
    } else {
      throw err;
    }
  }

  ctx.fs.ensureDirSync(path.dirname(options.logFile));

  try {
    const { pid } = spawnDetached(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      logFile: options.logFile,
    });

    await ctx.fs.writeAtomic(pidFile, String(pid));

    let alive = isAliveByPidFile(clawId);
    const deadline = Date.now() + PROCESS_SPAWN_CONFIRM_MS;
    while (!alive && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, SPAWN_POLL_INTERVAL_MS));
      alive = isAliveByPidFile(clawId);
    }
    if (!alive) {
      throw new Error(`Process "${clawId}" failed to start. Check logs at: ${options.logFile}`);
    }

    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED,
      `claw=${clawId}`,
      `pid=${pid}`,
      `command=${options.command}`,
      `args=${options.args.join(' ').slice(0, AUDIT_MESSAGE_MAX_CHARS)}`,
    );

    return pid;
  } catch (err) {
    await removePid(ctx, clawId).catch((removeErr) => {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_FAILED,
        `claw=${clawId}`,
        `context=spawn_cleanup`,
        `reason=${removeErr instanceof Error ? removeErr.message : String(removeErr)}`,
      );
    });
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED,
      `claw=${clawId}`,
      `command=${options.command}`,
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
