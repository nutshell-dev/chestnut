import { ensureStatusDir, getLockFile, getPidFile } from './paths.js';
import * as path from 'path';
import { formatErr } from "../utils/index.js";
import { spawnDetached as defaultSpawnDetached, kill as defaultKill } from '../process-exec/index.js';
import { DAEMON_SHUTDOWN_GRACE_MS, SPAWN_POLL_INTERVAL_MS } from './constants.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { isFileNotFound } from '../fs/types.js';
import { ProcessListUnavailable } from './errors.js';
import { isAliveByPidFile as checkAlive } from './alive.js';
import { isReady as checkReady } from './ready.js';
import { readLockPid } from './lock.js';
import { readPid, removePid } from './pid.js';
import type { PidFileContent } from './pid.js';
import { findProcessesDetailed, commandContainsClawIdToken } from './find.js';

import { isAlive as defaultL1IsAlive, getProcessStartTime as defaultGetProcessStartTime } from '../process-exec/index.js';
import { LockConflictError, type ProcessManagerContext } from './types.js';
import type { SpawnOptions } from './types.js';
import type { ClawId } from '../../constants.js';


const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spawn the daemon process for `clawId` and resolve with its PID once the
 * child has marked itself ready.
 *
 * Pipeline:
 *   1. alive precheck — bail if a live process already holds the pidfile
 *   2. orphan cleanup — SIGTERM matching processes from previous run
 *   3. lock cleanup   — drop stale lockfile (kill live holder first)
 *   4. pidfile claim  — `writeExclusiveSync`; on EEXIST verify + recover or reject
 *   5. child spawn    — `spawnDetached` + atomic pidfile overwrite with real PID
 *   6. readiness wait — poll until ready file appears or child dies (event-driven,
 *                       no wall-clock deadline — phase 1317)
 *
 * @param ctx       Process manager context (fs + audit + resolveDir + optional this-seam)
 * @param clawId    Target claw
 * @param options   Spawn options (command/args/env/cwd/logFile)
 * @returns         The spawned child's PID
 * @throws LockConflictError if a live process already owns the pidfile
 * @throws Error              if the child dies during boot before becoming ready
 *                            (also written to audit as PROCESS_SPAWN_FAILED)
 */
export async function spawnProcess(
  ctx: ProcessManagerContext,
  clawId: ClawId,
  options: SpawnOptions,
): Promise<number> {
  const startMs = Date.now();
  const isAliveByPidFile = ctx.isAlive ?? ((id: ClawId) => checkAlive(ctx, id));
  if (isAliveByPidFile(clawId)) {
    throw new LockConflictError(
      clawId,
      `Claw "${clawId}" is already running (PID file exists)`,
    );
  }

  await cleanupOrphans(ctx, clawId, options);
  await cleanupLock(ctx, clawId);
  await writePidExclusive(ctx, clawId);

  ctx.fs.ensureDirSync(path.dirname(options.logFile));

  return await spawnAndAwaitReady(ctx, clawId, options, startMs, isAliveByPidFile);
}

/**
 * SIGTERM stale processes whose argv matches the new spawn target so they
 * don't race the new daemon. Failures are audited but never throw — orphan
 * cleanup is best-effort.
 */
async function cleanupOrphans(
  ctx: ProcessManagerContext,
  clawId: ClawId,
  options: SpawnOptions,
): Promise<void> {
  const pattern = options.args.join(' ');
  // phase 346 B2 (review-2026-06-13): pgrep -f 用 regex-substring 匹配，
  // claw-a 会匹配 claw-abc / claw-a-1 等 prefix-collision claw → 误杀 sibling
  // daemon。先 detailed 列、再按 clawId token-match 二次过滤。
  let processes: Array<{ pid: number; command: string }> = [];
  try {
    processes = findProcessesDetailed(ctx, pattern);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) {
      // 降级：孤儿清理跳过；spawn 继续
      return;
    }
    throw err;
  }

  let sentAny = false;
  let orphanFailCount = 0;
  let skippedMismatch = 0;
  for (const proc of processes) {
    // 二次过滤：command 必须含 clawId 作为独立 token、非 substring
    // command 为空（ps 失败 fallback）时保守 skip + audit、不 kill
    if (!commandContainsClawIdToken(proc.command, clawId)) {
      skippedMismatch++;
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_MATCH_SKIPPED,
        `claw=${clawId}`,
        `pid=${proc.pid}`,
        `reason=clawid_token_mismatch`,
      );
      continue;
    }
    try {
      (ctx.kill ?? defaultKill)(proc.pid, 'TERM');
      sentAny = true;
    } catch (err) {
      orphanFailCount++;
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_SIGTERM_FAILED,
        `claw=${clawId}`,
        `pid=${proc.pid}`,
        `reason=${formatErr(err)}`,
      );
    }
  }
  // skippedMismatch 计数仅 audit、不计 failure（这些不是真 orphan、是 sibling）
  void skippedMismatch;
  if (orphanFailCount > 0) {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_CLEANUP_PARTIAL,
      `claw=${clawId}`,
      `sent=${sentAny ? 'true' : 'false'}`,
      `failed=${orphanFailCount}`,
    );
  }
  if (sentAny) {
    await sleep(DAEMON_SHUTDOWN_GRACE_MS);
  }
}

/**
 * Clear any stale lockfile from a previous run. If the holder is still alive
 * SIGTERM it first, then delete the lockfile. Errors are audited; non-ENOENT
 * delete failures keep the pipeline going (a later `writeExclusiveSync` will
 * eventually surface conflicts).
 */
async function cleanupLock(
  ctx: ProcessManagerContext,
  clawId: ClawId,
): Promise<void> {
  const lockFile = getLockFile(ctx, clawId);
  try {
    const lockHolder = readLockPid(ctx, clawId);
    if (lockHolder !== null) {
      const lockStartTime = lockHolder.startTime;
      if ((ctx.l1IsAlive ?? defaultL1IsAlive)(lockHolder.pid, lockStartTime)) {
        try {
          (ctx.kill ?? defaultKill)(lockHolder.pid, 'TERM');
          await sleep(DAEMON_SHUTDOWN_GRACE_MS);
        } catch (err) {
          ctx.audit.write(
            PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
            `claw=${clawId}`,
            `op=sigterm`,
            `pid=${lockHolder.pid}`,
            `reason=${formatErr(err)}`,
          );
        }
      }
    }
    try {
      await ctx.fs.delete(lockFile);
    } catch (err) {
      if (!isFileNotFound(err)) {
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
          `claw=${clawId}`,
          `op=delete`,
          `path=${lockFile}`,
          `reason=${formatErr(err)}`,
        );
      }
    }
  } catch (err) {
    if (!isFileNotFound(err)) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_READ_FAILED,
        `claw=${clawId}`,
        `reason=${(err as NodeJS.ErrnoException).code || formatErr(err)}`,
      );
    }
  }
}

/**
 * Claim the pidfile exclusively. On EEXIST, hand off to {@link handlePidFileConflict}
 * to verify the holder, recover stale state, and retry the write — or reject
 * with `LockConflictError` if a live process still owns it.
 */
async function writePidExclusive(
  ctx: ProcessManagerContext,
  clawId: ClawId,
): Promise<void> {
  const pidFile = getPidFile(ctx, clawId);
  await ensureStatusDir(ctx, clawId);

  try {
    // phase 458 (review N3-M): 写 pid=0 占位 sentinel 而非父进程 PID。
    // 改前 JSON.stringify({ pid: process.pid }) = 父 PID、外部 stop 在子 PID
    // 覆盖（L322）前若 SIGTERM 会误杀父进程。alive.ts pid===0 分支识别为
    // "spawning placeholder" 跳过 kill 决策。
    ctx.fs.writeExclusiveSync(pidFile, JSON.stringify({ pid: 0 }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    await handlePidFileConflict(ctx, clawId, pidFile);
  }
}

/**
 * EEXIST recovery path for {@link writePidExclusive}.
 *
 * PID-recycling defense: read the stored PID + startTime and only declare
 * a real conflict if the holder is provably alive. Otherwise audit whatever
 * race symptoms we observed (empty content, ENOENT during readback, …),
 * remove the stale pidfile, and re-attempt the exclusive write.
 *
 * Throws `LockConflictError` when the holder is live; falls through silently
 * (write retried in caller-visible state) when stale and reclaimable.
 */
async function handlePidFileConflict(
  ctx: ProcessManagerContext,
  clawId: ClawId,
  pidFile: string,
): Promise<void> {
  const stored = await readPid(ctx, clawId);
  if (stored !== null) {
    const startTimeForVerify = stored.startTime ?? (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(stored.pid);
    if ((ctx.l1IsAlive ?? defaultL1IsAlive)(stored.pid, startTimeForVerify)) {
      throw new LockConflictError(
        clawId,
        `Claw "${clawId}" is already running (PID file exists)`,
      );
    }
    // phase 182: PID-wrap detection emit (phase 1023 intent)
    if (stored.startTime !== undefined && stored.startTime !== startTimeForVerify) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.STARTTIME_MISMATCH,
        `claw=${clawId}`,
        `stored_pid=${stored.pid}`,
        `stored_startTime=${stored.startTime}`,
        `verify_startTime=${startTimeForVerify ?? 'unavailable'}`,
      );
    }
    // startTime mismatch or unavailable → fall through to stale cleanup
  }
  // pidfile disappeared during check → fall through to stale cleanup

  let existingContent = '';
  let readSucceeded = false;
  try {
    existingContent = ctx.fs.readSync(pidFile).trim();
    readSucceeded = true;
  } catch (readErr) {
    if (isFileNotFound(readErr)) {
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
        `reason=${formatErr(readErr)}`,
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
      `reason=${formatErr(err)}`,
    );
  });
  // phase 518 (review-round4 medium、phase 458 gap 补完): EEXIST 恢复分支同 phase 458 主路径、
  // 写 pid=0 sentinel 而非 process.pid（父 PID）；alive.ts pid===0 识别为 spawning placeholder。
  ctx.fs.writeExclusiveSync(pidFile, JSON.stringify({ pid: 0 }));
}

/**
 * Spawn the child, overwrite the pidfile with the real child PID, and poll
 * until the ready marker appears or the child dies during boot.
 *
 * Polling is event-driven (no wall-clock deadline — phase 1317). Hang case
 * relies on user Ctrl-C / OS `timeout(1)` wrapper to escalate.
 *
 * On failure: audits PROCESS_SPAWN_FAILED and best-effort removes the pidfile
 * so the next spawn attempt doesn't false-conflict.
 */
async function spawnAndAwaitReady(
  ctx: ProcessManagerContext,
  clawId: ClawId,
  options: SpawnOptions,
  startMs: number,
  isAliveByPidFile: (id: ClawId) => boolean,
): Promise<number> {
  const pidFile = getPidFile(ctx, clawId);
  try {
    const { pid } = (ctx.spawnDetached ?? defaultSpawnDetached)(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      logFile: options.logFile,
    });

    const childStartTime = (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(pid);
    const pidPayload: PidFileContent = {
      pid,
      ...(childStartTime !== undefined ? { startTime: childStartTime } : {}),
    };
    await ctx.fs.writeAtomic(pidFile, JSON.stringify(pidPayload));

    const isReady = ctx.isReady ?? ((id: ClawId) => checkReady(ctx, id));
    let ready = isReady(clawId);
    while (!ready) {
      if (!isAliveByPidFile(clawId)) {
        throw new Error(
          `Process "${clawId}" died during boot. Check logs at: ${options.logFile}`,
        );
      }
      await sleep(SPAWN_POLL_INTERVAL_MS);
      ready = isReady(clawId);
    }

    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED,
      `claw=${clawId}`,
      `pid=${pid}`,
      `command=${options.command}`,
      `args=${ctx.audit.message(options.args.join(' '))}`,
      `duration_ms=${Date.now() - startMs}`,
    );

    return pid;
  } catch (err) {
    await removePid(ctx, clawId).catch((removeErr) => {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PID_REMOVE_FAILED,
        `claw=${clawId}`,
        `context=spawn_cleanup`,
        `reason=${formatErr(removeErr)}`,
      );
    });
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED,
      `claw=${clawId}`,
      `command=${options.command}`,
      `reason=${formatErr(err)}`,
      `code=${(err as NodeJS.ErrnoException).code ?? 'unknown'}`,
      `duration_ms=${Date.now() - startMs}`,
    );
    throw err;
  }
}
