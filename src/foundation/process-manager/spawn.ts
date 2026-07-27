import { getLockFile, getPidFile } from './paths.js';
import type { DaemonDir } from './types.js';
import * as path from 'path';
import { formatErr } from "../node-utils/index.js";
import { spawnDetached as defaultSpawnDetached, kill as defaultKill } from '../process-exec/index.js';
import { DAEMON_SHUTDOWN_GRACE_MS, SPAWN_POLL_INTERVAL_MS } from './constants.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { ProcessListUnavailable } from './errors.js';
import { isAliveByPidFile as checkAlive } from './alive.js';
import { isReady as checkReady } from './ready.js';
import { readLock } from './lock.js';
import { removePid } from './pid.js';
import type { PidFileContent } from './pid.js';
import { findProcessesDetailed, commandContainsDaemonDirToken } from './find.js';
import {
  newProcessGeneration,
  prepareGeneration,
  commitSpawning,
  inspectSpawning,
  writeChildPid,
  writeFailureFact,
  retireGeneration,
  PROCESS_GENERATION_ENV,
  type ProcessGenerationRecord,
} from './generation.js';
import { isFileNotFound } from '../fs/index.js';

import { isAlive as defaultL1IsAlive, getProcessStartTime as defaultGetProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import { LockConflictError, type ProcessManagerContext } from './types.js';
import type { SpawnOptions } from './types.js';



const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spawn the daemon process for `daemonDir` and resolve with its PID once the
 * child has marked itself ready.
 *
 * Pipeline (Phase 1204 Step B — generation 目录提交协议，无 spawn lock / pid:0）：
 *   1. alive precheck       — legacy pidfile 判活（过渡；Step E 迁 generation 读路径）
 *   2. orphan cleanup       — SIGTERM matching processes from previous run
 *   3. lock cleanup         — drop stale legacy lockfile (kill live holder first)
 *   4. spawning precheck    — 已有 spawning generation → typed conflict / malformed fail-closed
 *   5. generation commit    — candidate → spawning（move winner 才可 spawn）
 *   6. child spawn          — `spawnDetached` + generation ID 显式注入 child env；
 *                             pid.json 写 spawning（existing-generation 语义）；
 *                             legacy status/pid 双写（派生 artifact，Step E 删除）
 *   7. readiness wait       — poll until ready or child dies（l1IsAlive 直探 child PID，
 *                             event-driven + BOOT_DEADLINE_MS 兜底）
 *
 * @param ctx       Process manager context (fs + audit + resolveDir + optional this-seam)
 * @param daemonDir    Target claw
 * @param options   Spawn options (command/args/env/cwd/logFile)
 * @returns         The spawned child's PID
 * @throws LockConflictError if a live process already owns the daemon or another
 *                         spawn generation holds spawning
 * @throws Error              if the child dies during boot before becoming ready
 *                            (also written to audit as PROCESS_SPAWN_FAILED)
 */
export async function spawnProcess(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  options: SpawnOptions,
): Promise<number> {
  const startMs = Date.now();
  const isAliveByPidFile = ctx.isAlive ?? ((id: DaemonDir) => checkAlive(ctx, id));
  if (isAliveByPidFile(daemonDir)) {
    throw new LockConflictError(
      daemonDir,
      `Claw "${daemonDir}" is already running (PID file exists)`,
    );
  }

  await cleanupOrphans(ctx, daemonDir, options);
  await cleanupLock(ctx, daemonDir);

  // generation precheck：spawning 已被持 → typed conflict（不从异常猜 winner）；
  // malformed → fail-closed（不覆盖、不猜状态）。
  const spawningInspection = inspectSpawning(ctx, daemonDir);
  if (spawningInspection.status === 'ok') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST,
      `daemon_dir=${daemonDir}`,
      `ctx=spawn_precheck`,
      `winner_generation=${spawningInspection.record.generation_id}`,
      `winner_parent_pid=${spawningInspection.record.parent_pid}`,
    );
    throw new LockConflictError(
      daemonDir,
      `Claw "${daemonDir}" spawn already in progress (generation ${spawningInspection.record.generation_id})`,
    );
  }
  if (spawningInspection.status === 'malformed') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `dir=spawning`,
      `ctx=spawn_precheck`,
      `reason=${ctx.audit.message(formatErr(spawningInspection.cause))}`,
    );
    throw new LockConflictError(
      daemonDir,
      `Cannot determine spawning generation state for "${daemonDir}" (malformed)`,
    );
  }

  // candidate → spawning：move winner 才可 spawn；另一 spawn 读取真实位置返回 typed conflict。
  const record = newProcessGeneration(ctx, daemonDir);
  prepareGeneration(ctx, record);
  const commit = commitSpawning(ctx, record);
  if (commit.kind === 'foreign_spawning') {
    throw new LockConflictError(
      daemonDir,
      `Claw "${daemonDir}" spawn race lost to generation ${commit.winner.generation_id}`,
    );
  }
  if (commit.kind === 'malformed_spawning') {
    throw new LockConflictError(
      daemonDir,
      `Cannot commit spawn generation for "${daemonDir}" (malformed spawning)`,
    );
  }
  if (commit.kind === 'retryable_failure') {
    throw new Error(
      `Failed to commit spawn generation for "${daemonDir}": ${formatErr(commit.cause)}`,
    );
  }

  ctx.fs.ensureDirSync(path.dirname(options.logFile));

  return await spawnAndAwaitReady(ctx, daemonDir, options, startMs, record);
}

/**
 * SIGTERM stale processes whose argv matches the new spawn target so they
 * don't race the new daemon. Failures are audited but never throw — orphan
 * cleanup is best-effort.
 */
async function cleanupOrphans(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  options: SpawnOptions,
): Promise<void> {
  const pattern = options.args.join(' ');
  // phase 346 B2 (review-2026-06-13): pgrep -f 用 regex-substring 匹配，
  // claw-a 会匹配 claw-abc / claw-a-1 等 prefix-collision claw → 误杀 sibling
  // daemon。先 detailed 列、再按 daemonDir token-match 二次过滤。
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
    // 二次过滤：command 必须含 daemonDir 作为独立 token、非 substring
    // command 为空（ps 失败 fallback）时保守 skip + audit、不 kill
    if (!commandContainsDaemonDirToken(proc.command, daemonDir)) {
      skippedMismatch++;
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.ORPHAN_MATCH_SKIPPED,
        `daemon_dir=${daemonDir}`,
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
        `daemon_dir=${daemonDir}`,
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
      `daemon_dir=${daemonDir}`,
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
 * throw LockConflictError — never kill a live holder. Only stale (dead) locks
 * are removed. Errors are audited; non-ENOENT delete failures keep the pipeline
 * going (a later `writeExclusiveSync` will eventually surface conflicts).
 */
async function cleanupLock(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): Promise<void> {
  const result = readLock(ctx, daemonDir);
  if (result.status === 'missing') {
    return; // nothing to clean
  }
  if (result.status === 'io_error' || result.status === 'corrupt') {
    // Cannot determine state — keep lock, don't remove
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
      `daemon_dir=${daemonDir}`,
      `op=stale_cleanup`,
      `reason=cannot_determine_state`,
      `detail=${result.error}`,
    );
    return;
  }
  // result.status === 'valid' — check if holder is alive
  const lockHolder = result.holder;
  const lockStartTime = lockHolder.startTime;
  if ((ctx.l1IsAlive ?? defaultL1IsAlive)(lockHolder.pid, lockStartTime)) {
    // Holder is alive — throw, don't kill. Let the caller handle the conflict.
    throw new LockConflictError(
      daemonDir,
      `Another "${daemonDir}" daemon is running (PID: ${lockHolder.pid})`,
    );
  }
  // Holder is dead — safe to clean up stale lock
  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
    `daemon_dir=${daemonDir}`,
    `op=stale_cleanup`,
    `pid=${lockHolder.pid}`,
    `reason=holder_dead`,
  );
  const lockFile = getLockFile(ctx, daemonDir);
  try {
    await ctx.fs.delete(lockFile);
  } catch (err) {
    if (!isFileNotFound(err)) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
        `daemon_dir=${daemonDir}`,
        `op=delete`,
        `path=${lockFile}`,
        `reason=${formatErr(err)}`,
      );
    }
  }
}

const BOOT_DEADLINE_MS = 30_000; // 30s for daemon to become ready

/**
 * Spawn the child, persist its PID into the spawning generation, and poll
 * until ready or child death.
 *
 * 死亡检测直探 child PID（l1IsAlive(pid, startTime)），不经 pidfile probe ——
 * parent 不再写 status/pid  sentinel，磁盘 generation record 即可重建运行时句柄。
 *
 * On failure: kill 精确 child（PID 属本 generation）、写 failure 事实、retire
 * spawning（无孤儿、无悬空 spawning），audit PROCESS_SPAWN_FAILED。
 */
async function spawnAndAwaitReady(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  options: SpawnOptions,
  startMs: number,
  record: ProcessGenerationRecord,
): Promise<number> {
  let pid: number | undefined;
  let childStartTime: ProcessStartTime | undefined;
  try {
    // generation ID 显式传入 child 环境（CHESTNUT_* 落 env-scrub allowlist）——
    // 跨进程交接必须携带 generation identity，child 不得「扫描 spawning 猜是自己」。
    const baseEnv = options.env ?? process.env;
    const childEnv = { ...baseEnv, [PROCESS_GENERATION_ENV]: record.generation_id };
    ({ pid } = (ctx.spawnDetached ?? defaultSpawnDetached)(options.command, options.args, {
      cwd: options.cwd,
      env: childEnv,
      logFile: options.logFile,
    }));

    childStartTime = (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(pid);

    // generation pid.json 是 child PID 的 SoT；existing-generation 语义 —
    // 目录已 move 走则返回 generation_moved，绝不复活。
    const pidWrite = await writeChildPid(ctx, record, pid, childStartTime);
    if (pidWrite.kind !== 'written') {
      throw new Error(
        `Cannot persist child PID for "${daemonDir}" generation ${record.generation_id} (${pidWrite.kind})`,
      );
    }

    // legacy status/pid 双写（过渡期派生 artifact：ready/alive 读路径尚未迁移，
    // Step C 读路径 generation 化后删除，legacy 迁移归 Step E）。
    const pidPayload: PidFileContent = {
      pid,
      ...(childStartTime !== undefined ? { startTime: childStartTime } : {}),
    };
    await ctx.fs.writeAtomic(getPidFile(ctx, daemonDir), JSON.stringify(pidPayload));

    const l1IsAlive = ctx.l1IsAlive ?? defaultL1IsAlive;
    const isReady = ctx.isReady ?? ((id: DaemonDir) => checkReady(ctx, id));
    let ready = isReady(daemonDir);
    const bootStart = Date.now();
    while (!ready) {
      if (Date.now() - bootStart > BOOT_DEADLINE_MS) {
        throw new Error(
          `Process "${daemonDir}" did not become ready within ${BOOT_DEADLINE_MS}ms. ` +
          `Check logs at: ${options.logFile}`,
        );
      }
      if (!l1IsAlive(pid, childStartTime)) {
        throw new Error(
          `Process "${daemonDir}" died during boot. Check logs at: ${options.logFile}`,
        );
      }
      await sleep(SPAWN_POLL_INTERVAL_MS);
      ready = isReady(daemonDir);
    }

    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED,
      `daemon_dir=${daemonDir}`,
      `pid=${pid}`,
      `generation=${record.generation_id}`,
      `command=${options.command}`,
      `args=${ctx.audit.message(options.args.join(' '))}`,
      `duration_ms=${Date.now() - startMs}`,
    );

    return pid;
  } catch (err) {
    // If child was spawned, terminate it. Don't leave orphans.
    // Guard against self-kill (tests may inject process.pid as a mock child).
    let childSurvived = false;
    if (typeof pid === 'number' && pid > 0 && pid !== process.pid) {
      try {
        (ctx.kill ?? defaultKill)(pid, 'TERM');
        // Grace period for child to exit on SIGTERM
        await sleep(DAEMON_SHUTDOWN_GRACE_MS);
        const aliveAfterTerm = childStartTime !== undefined
          ? (ctx.l1IsAlive ?? defaultL1IsAlive)(pid, childStartTime)
          : (ctx.l1IsAlive ?? defaultL1IsAlive)(pid);
        if (aliveAfterTerm) {
          (ctx.kill ?? defaultKill)(pid, 'KILL');
          await sleep(500);
        }
      } catch (killErr) {
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
          `daemon_dir=${daemonDir}`,
          `op=spawn_failed_kill`,
          `pid=${pid}`,
          `reason=${formatErr(killErr)}`,
        );
      }
      const stillAlive = childStartTime !== undefined
        ? (ctx.l1IsAlive ?? defaultL1IsAlive)(pid, childStartTime)
        : (ctx.l1IsAlive ?? defaultL1IsAlive)(pid);
      if (stillAlive) {
        childSurvived = true;
        // Child survived SIGTERM + SIGKILL. Keep PID file + generation for forensics.
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.LOCKFILE_CLEANUP_FAILED,
          `daemon_dir=${daemonDir}`,
          `op=spawn_failed_child_survived`,
          `pid=${pid}`,
          `reason=child_still_alive_after_kill_attempts`,
        );
      }
    }
    if (!childSurvived) {
      // generation disposition：失败事实随 generation 持久化后整体 retire —
      // 无孤儿、无悬空 spawning；legacy status/pid 双写清理（0 残留）。
      await writeFailureFact(ctx, record, formatErr(err));
      retireGeneration(ctx, daemonDir, { generationId: record.generation_id }, 'spawn_failed', 'spawning');
      await removePid(ctx, daemonDir, 'spawn_cleanup');
    }
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED,
      `daemon_dir=${daemonDir}`,
      `generation=${record.generation_id}`,
      `command=${options.command}`,
      `reason=${formatErr(err)}`,
      `code=${(err as NodeJS.ErrnoException).code ?? 'unknown'}`,
      `duration_ms=${Date.now() - startMs}`,
    );
    throw err;
  }
}
