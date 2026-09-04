import type { DaemonDir } from './types.js';
import * as path from 'path';
import { formatErr } from '../node-utils/index.js';
import { spawnDetached as defaultSpawnDetached, kill as defaultKill, ProcessListUnavailable } from '../process-exec/index.js';
import { BOOT_DEADLINE_MS, DAEMON_SHUTDOWN_GRACE_MS } from './constants.js';
import { awaitReadyConvergence } from './ready-convergence.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { isReady as checkReady } from './ready.js';
import { findProcessesDetailed, commandContainsDaemonDirToken } from './find.js';
import {
  newProcessGeneration,
  prepareGeneration,
  commitSpawning,
  inspectSpawning,
  inspectActive,
  inspectActivePid,
  writeChildPid,
  writeFailureFact,
  retireGeneration,
  PROCESS_GENERATION_ENV,
  type ProcessGenerationRecord,
} from './generation.js';
import { shouldAbortSpawningForStop } from './stop.js';

import { isAlive as defaultL1IsAlive, getProcessStartTime as defaultGetProcessStartTime, type ProcessStartTime } from '../process-exec/index.js';
import { ProcessGenerationStateError, ProcessSpawnConflictError, type ProcessManagerContext } from './types.js';
import type { SpawnOptions } from './types.js';



const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spawn the daemon process for `daemonDir` and resolve with its PID once the
 * child has marked itself ready.
 *
 * Pipeline (Phase 1204 Step E — generation 目录是排他原语，无 lock / pid:0 / legacy pidfile）：
 *   1. active precheck      — 有 active generation 且进程仍活 → ProcessSpawnConflictError(active_owner)
 *   2. orphan cleanup       — SIGTERM matching processes from previous run
 *   3. spawning precheck    — 已有 spawning generation → ProcessSpawnConflictError(spawn_in_progress)
 *                             / malformed → ProcessGenerationStateError fail-closed
 *   4. generation commit    — candidate → spawning（move winner 才可 spawn）
 *   5. child spawn          — `spawnDetached` + generation ID 显式注入 child env；
 *                             pid.json 写 spawning（existing-generation 语义）
 *   6. stop-intent check    — spawning 阶段存在 stop intent 立即 abort
 *   7. readiness wait       — poll until ready or child dies（l1IsAlive 直探 child PID，
 *                             event-driven + BOOT_DEADLINE_MS 兜底）
 *
 * @param ctx       Process manager context (fs + audit + optional this-seam)
 * @param daemonDir Target daemon owner directory
 * @param options   Spawn options (command/args/env/cwd/logFile)
 * @returns         The spawned child's PID
 * @throws ProcessSpawnConflictError  if a live process already owns the daemon or another
 *                                    spawn generation holds spawning（合法竞争，含 reason +
 *                                    winner generation ID）
 * @throws ProcessGenerationStateError if active/spawning generation 持久状态 malformed
 *                                    （fail-closed，携带 location/operation/cause）
 * @throws Error                       if the child dies during boot before becoming ready
 *                                     (also written to audit as PROCESS_SPAWN_FAILED)
 */
export async function spawnProcess(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  options: SpawnOptions,
): Promise<number> {
  const startMs = Date.now();

  const active = inspectActive(ctx, daemonDir);
  if (active.status === 'malformed') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `dir=active`,
      `ctx=spawn_precheck`,
      `reason=${ctx.audit.message(formatErr(active.cause))}`,
    );
    throw new ProcessGenerationStateError(
      daemonDir,
      'active',
      'inspect',
      active.cause,
      `Cannot determine active generation state for "${daemonDir}" (malformed)`,
    );
  }
  if (active.status === 'ok') {
    const activePid = inspectActivePid(ctx, daemonDir);
    const pid = activePid.status === 'ok' ? activePid.record.pid : undefined;
    const startTime = activePid.status === 'ok' ? activePid.record.start_time as ProcessStartTime | undefined : undefined;
    if (pid !== undefined && (ctx.l1IsAlive ?? defaultL1IsAlive)(pid, startTime)) {
      throw new ProcessSpawnConflictError(
        daemonDir,
        'active_owner',
        active.record.generation_id,
        `Another "${daemonDir}" daemon is already running (generation ${active.record.generation_id})`,
      );
    }
    // active generation 存在但进程已死：旧 daemon 已退出，继续 spawn 会覆盖 active。
    // 这里先 retire 旧 active，让新 generation 有干净的 active 目标。
    retireGeneration(ctx, daemonDir, { generationId: active.record.generation_id }, 'confirmed_dead', 'active');
  }

  await cleanupOrphans(ctx, daemonDir, options);

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
    throw new ProcessSpawnConflictError(
      daemonDir,
      'spawn_in_progress',
      spawningInspection.record.generation_id,
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
    throw new ProcessGenerationStateError(
      daemonDir,
      'spawning',
      'inspect',
      spawningInspection.cause,
      `Cannot determine spawning generation state for "${daemonDir}" (malformed)`,
    );
  }

  // candidate → spawning：move winner 才可 spawn；另一 spawn 读取真实位置返回 typed conflict。
  const record = newProcessGeneration(ctx, daemonDir);
  prepareGeneration(ctx, record);
  const commit = commitSpawning(ctx, record);
  if (commit.kind === 'foreign_spawning') {
    throw new ProcessSpawnConflictError(
      daemonDir,
      'commit_lost',
      commit.winner.generation_id,
      `Claw "${daemonDir}" spawn race lost to generation ${commit.winner.generation_id}`,
    );
  }
  if (commit.kind === 'malformed_spawning') {
    throw new ProcessGenerationStateError(
      daemonDir,
      'spawning',
      'commit',
      commit.cause,
      `Cannot commit spawn generation for "${daemonDir}" (malformed spawning)`,
    );
  }
  if (commit.kind === 'retryable_failure') {
    throw new Error(
      `Failed to commit spawn generation for "${daemonDir}": ${formatErr(commit.cause)}`,
    );
  }

  // Step F barrier 1：commit spawning 后、spawn child 前检查本代 stop intent。
  if (shouldAbortSpawningForStop(ctx, daemonDir, record.generation_id)) {
    await writeFailureFact(ctx, record, 'stop intent recorded before child spawned');
    retireGeneration(ctx, daemonDir, { generationId: record.generation_id }, 'stopped', 'spawning');
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED,
      `daemon_dir=${daemonDir}`,
      `generation=${record.generation_id}`,
      `reason=stop_intent_recorded_before_child_spawned`,
    );
    throw new Error(
      `Spawn aborted for "${daemonDir}" generation ${record.generation_id} due to stop intent`,
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
 * Phase 1282 Step C：ready 等待的 deadline/poll 调度唯一归
 * ready-convergence.ts 原语；spawn 只提供 self-winner 观察器与错误上下文。
 */

/**
 * Spawn the child, persist its PID into the spawning generation, and poll
 * until ready or child death.
 *
 * 死亡检测直探 child PID（l1IsAlive(pid, startTime)），不经 pidfile probe ——
 * 磁盘 generation record 即可重建运行时句柄。
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
    // phase 1763: detached spawn 提交点由 owner（process-exec）以 child 'spawn'
    // 事件定义；pre-commit 同步/异步失败经 typed outcome 返回（保留原始
    // errno/时间/命令身份），不得以 pid 非空或后续 liveness 替代；提交点后
    // 异步失败经 audit sink 交付。
    const spawnOutcome = await (ctx.spawnDetached ?? defaultSpawnDetached)(
      options.command,
      options.args,
      {
        cwd: options.cwd,
        env: childEnv,
        logFile: options.logFile,
        onSpawnFailure: (failure) => {
          ctx.audit.write(
            PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_POST_COMMIT_FAILED,
            `daemon_dir=${daemonDir}`,
            `command=${failure.command}`,
            `pid=${failure.pid ?? 'unknown'}`,
            `errno=${failure.errno ?? failure.code ?? 'unknown'}`,
            `at=${failure.atMs}`,
            `error=${failure.message}`,
          );
        },
      },
    );
    if (spawnOutcome.kind === 'failed') {
      const f = spawnOutcome.failure;
      throw new Error(
        `Spawn pre-commit failure for "${daemonDir}" command "${f.command}"` +
          ` (errno=${f.errno ?? f.code ?? 'unknown'}, at=${f.atMs}): ${f.message}`,
      );
    }
    pid = spawnOutcome.pid;

    childStartTime = (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(pid);

    // generation pid.json 是 child PID 的 SoT；existing-generation 语义 —
    // 目录已 move 走则返回 generation_moved，绝不复活。
    const pidWrite = await writeChildPid(ctx, record, pid, childStartTime);
    if (pidWrite.kind !== 'written') {
      throw new Error(
        `Cannot persist child PID for "${daemonDir}" generation ${record.generation_id} (${pidWrite.kind})`,
      );
    }

    // Step F barrier 2：写 PID 后再次检查本代 stop intent。
    if (shouldAbortSpawningForStop(ctx, daemonDir, record.generation_id)) {
      try {
        (ctx.kill ?? defaultKill)(pid, 'TERM');
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
          PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
          `daemon_dir=${daemonDir}`,
          `pid=${pid}`,
          `ctx=spawn_stop_intent_abort`,
          `reason=${formatErr(killErr)}`,
        );
      }
      await writeFailureFact(ctx, record, 'stop intent recorded before boot completed');
      retireGeneration(ctx, daemonDir, { generationId: record.generation_id }, 'stopped', 'spawning');
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED,
        `daemon_dir=${daemonDir}`,
        `generation=${record.generation_id}`,
        `reason=stop_intent_recorded_before_boot`,
      );
      throw new Error(
        `Spawn aborted for "${daemonDir}" generation ${record.generation_id} due to stop intent`,
      );
    }

    const l1IsAlive = ctx.l1IsAlive ?? defaultL1IsAlive;
    const isReady = ctx.isReady ?? ((id: DaemonDir) => checkReady(ctx, id));
    // Phase 1282 Step C：deadline/poll 调度由共享原语拥有；本观察器只解释
    // self-winner 事实（ready 事实 / child liveness），保留既有错误消息。
    const bootPid: number = pid; // 闭包内 narrowing 不复用，显式固定 child PID
    await awaitReadyConvergence(
      () => {
        if (isReady(daemonDir)) return { kind: 'ready', value: undefined };
        if (!l1IsAlive(bootPid, childStartTime)) {
          return {
            kind: 'failed',
            error: new Error(
              `Process "${daemonDir}" died during boot. Check logs at: ${options.logFile}`,
            ),
          };
        }
        return { kind: 'pending' };
      },
      () => new Error(
        `Process "${daemonDir}" did not become ready within ${BOOT_DEADLINE_MS}ms. ` +
        `Check logs at: ${options.logFile}`,
      ),
    );

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
          PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
          `daemon_dir=${daemonDir}`,
          `pid=${pid}`,
          `ctx=spawn_failed_kill`,
          `reason=${formatErr(killErr)}`,
        );
      }
      const stillAlive = childStartTime !== undefined
        ? (ctx.l1IsAlive ?? defaultL1IsAlive)(pid, childStartTime)
        : (ctx.l1IsAlive ?? defaultL1IsAlive)(pid);
      if (stillAlive) {
        childSurvived = true;
        // Child survived SIGTERM + SIGKILL. Keep generation for forensics.
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_FAILED,
          `daemon_dir=${daemonDir}`,
          `pid=${pid}`,
          `ctx=spawn_failed_child_survived`,
          `reason=child_still_alive_after_kill_attempts`,
        );
      }
    }
    if (!childSurvived) {
      // generation disposition：失败事实随 generation 持久化后整体 retire —
      // 无孤儿、无悬空 spawning。
      await writeFailureFact(ctx, record, formatErr(err));
      retireGeneration(ctx, daemonDir, { generationId: record.generation_id }, 'spawn_failed', 'spawning');
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
