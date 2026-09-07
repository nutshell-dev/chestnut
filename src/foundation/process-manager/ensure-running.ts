/**
 * @module L2a.ProcessManager.EnsureRunning
 * ProcessManager ready-winner convergence（Phase 1282 Step A）。
 *
 * `ensureRunning` 是「确保 daemon ready」的单一稳定能力，封装
 * precheck / spawn / conflict / join；调用方不得再自行组合 `liveness 判断 + spawn`
 * （TOCTOU：两步之间 Watchdog/另一 CLI 可提交 spawning winner）。
 *
 * 控制流：
 *   1. precheck   — active generation 已 ready 且进程存活 → already_ready
 *   2. spawn      — 无 winner → 本方走既有 spawnProcess（含全部 precheck/commit）
 *   3. join       — 合法 ProcessSpawnConflictError（active_owner / spawn_in_progress /
 *                   commit_lost）→ 等待 error 携带的 exact generation 收敛：
 *                   ready → joined；died / probe_unavailable / failed / retired /
 *                   replaced / vanished → typed ProcessWinnerConvergenceError
 *                   （不静默吞 conflict、不跟随新 winner）
 *
 * join 只依据磁盘事实（generation 位置 + PID/ready/failure 记录 + liveness probe）
 * 收敛，不依赖内存 promise 或固定 sleep 猜成功；与 spawn 共用同一 BOOT_DEADLINE_MS
 * ready 等待原语，不形成第二套时限策略。
 */

import {
  isAlive as defaultL1IsAlive,
  makeProcessStartTime,
} from '../process-exec/index.js';
import { formatErr } from '../node-utils/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { BOOT_DEADLINE_MS } from './constants.js';
import {
  awaitReadyConvergence,
  type ConvergenceObservation,
} from './ready-convergence.js';
import {
  inspectActive,
  inspectActivePid,
  inspectActiveReady,
  inspectRetiredFailure,
  inspectRetiredGeneration,
  inspectSpawning,
  inspectSpawningFailure,
  inspectSpawningPid,
  inspectSpawningReady,
} from './generation.js';
import { spawnProcess } from './spawn.js';
import {
  ProcessGenerationStateError,
  ProcessSpawnConflictError,
  ProcessWinnerConvergenceError,
  type DaemonDir,
  type EnsureRunningOutcome,
  type ProcessManagerContext,
  type ProcessWinnerConvergenceReason,
  type SpawnOptions,
} from './types.js';


/**
 * Ensure the daemon for `daemonDir` is running and ready.
 *
 * @returns EnsureRunningOutcome typed 三分支（spawned / already_ready / joined）
 * @throws ProcessSpawnConflictError 绝不由此抛出（合法 conflict 一律转 join）
 * @throws ProcessGenerationStateError active/spawning 持久状态 malformed（fail-closed）
 * @throws ProcessWinnerConvergenceError foreign winner 未收敛到 ready（含 reason + generationId）
 * @throws Error 本方 spawn 失败（child boot 死亡等，同 spawnProcess 契约）
 */
export async function ensureRunning(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  options: SpawnOptions,
): Promise<EnsureRunningOutcome> {
  const readyPid = readyActivePid(ctx, daemonDir);
  if (readyPid !== undefined) {
    return { kind: 'already_ready', pid: readyPid };
  }

  try {
    return { kind: 'spawned', pid: await spawnProcess(ctx, daemonDir, options) };
  } catch (error) {
    if (!(error instanceof ProcessSpawnConflictError)) throw error;
    return await joinWinner(ctx, daemonDir, error.generationId);
  }
}

/**
 * active generation 的 ready 交叉验证：generation/pid/ready 三事实同代、
 * pid 与 ready 指向同一进程、liveness 存活。满足则返回 PID，否则 undefined。
 * expectedGenerationId 传入时只认该 exact generation（join 不得误报其他 winner）。
 * malformed 事实由调用方按 fail-closed 处理，本函数按「不 ready」返回 undefined。
 */
function readyActivePid(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  expectedGenerationId?: string,
): number | undefined {
  const active = inspectActive(ctx, daemonDir);
  if (active.status !== 'ok') return undefined;
  if (expectedGenerationId !== undefined && active.record.generation_id !== expectedGenerationId) {
    return undefined;
  }
  const generationId = active.record.generation_id;

  const pid = inspectActivePid(ctx, daemonDir);
  if (pid.status !== 'ok' || pid.record.generation_id !== generationId) return undefined;
  const ready = inspectActiveReady(ctx, daemonDir);
  if (ready.status !== 'ok' || ready.record.generation_id !== generationId) return undefined;
  if (pid.record.pid !== ready.record.pid) return undefined;

  const probe = probeWinnerAlive(ctx, pid.record.pid, pid.record.start_time ?? ready.record.start_time);
  if (probe.kind === 'unavailable') {
    // phase 1775 precheck fail-closed：probe 系统故障 ≠ winner 死亡——无法确认
    // not-ready 时继续 spawn 有 double-spawn 风险，直接 typed 失败（保留原始 error）。
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.ENSURE_FAILED,
      `daemon_dir=${daemonDir}`,
      `generation=${generationId}`,
      `reason=winner_probe_unavailable`,
      `detail=${ctx.audit.message(`precheck probe unavailable: ${formatErr(probe.error)}`)}`,
    );
    throw new ProcessWinnerConvergenceError(
      daemonDir,
      'winner_probe_unavailable',
      generationId,
      `Active winner generation ${generationId} for "${daemonDir}" readiness probe unavailable (winner_probe_unavailable: ${formatErr(probe.error)})`,
      { cause: probe.error },
    );
  }
  return probe.kind === 'alive' ? pid.record.pid : undefined;
}

/**
 * phase 1775：winner liveness probe 三分支（owner-local，不 export）。
 * - alive：probe 返回 true；
 * - dead：probe 返回 false，或抛 ESRCH（pid 已消失 = 死亡终局，同 phase 1773 liveness owner）；
 * - unavailable：非 ESRCH 异常（EPERM/未知错误）保留原始 error identity——probe 系统故障
 *   ≠ winner 死亡；压平为 dead 会导致错误接管/foreign winner 实际存活时 double-spawn。
 */
type WinnerProbeResult =
  | { kind: 'alive' }
  | { kind: 'dead' }
  | { kind: 'unavailable'; error: unknown };

function probeWinnerAlive(ctx: ProcessManagerContext, pid: number, startTime?: string): WinnerProbeResult {
  try {
    return (ctx.l1IsAlive ?? defaultL1IsAlive)(
      pid,
      startTime !== undefined ? makeProcessStartTime(startTime) : undefined,
    )
      ? { kind: 'alive' }
      : { kind: 'dead' };
  } catch (error) {
    // ESRCH = pid 已消失（死亡终局，同 phase 1773 liveness owner 约定）
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return { kind: 'dead' };
    }
    // 其他 probe 异常 = 系统故障不压平：保留原始 error identity（≠ winner 死亡）
    return { kind: 'unavailable', error };
  }
}

/**
 * 等待 foreign winner 的 exact generation 收敛到 ready。
 *
 * 每轮按 generation 单向 move 方向（spawning → active → retired）从上游向下游
 * 读取位置与事实，避免「spawning 已 move 走、active 尚未读取」的双 none 误判：
 *   - spawning/<expected>：failure → winner_failed；ready 已写但进程死 → winner_died；
 *     probe 系统故障（非 ESRCH）→ winner_probe_unavailable（phase 1775，不归 died）；
 *     PID/ready 未齐属合法窗口 → 继续等待（不把「PID 事实稍后到达」当损坏）
 *   - active/<expected>：三事实交叉验证 + liveness 通过 → joined；
 *     事实齐但进程死 → winner_died；probe 系统故障 → winner_probe_unavailable；
 *     事实未齐（move 中途瞬时视角）→ 继续等待
 *   - retired/<expected>：带 failure 事实 → winner_failed，否则 → winner_retired
 *   - spawning/active 被其他 generation 占据 → winner_replaced（不得跟随新 winner）
 *   - 任何 slot 都无此 generation → winner_vanished（异常终局，显式失败）
 */
async function joinWinner(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  generationId: string,
): Promise<EnsureRunningOutcome> {
  const joinStart = Date.now();

  const fail = (reason: ProcessWinnerConvergenceReason, detail: string, cause?: unknown): never => {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.ENSURE_FAILED,
      `daemon_dir=${daemonDir}`,
      `generation=${generationId}`,
      `reason=${reason}`,
      `detail=${ctx.audit.message(detail)}`,
    );
    throw new ProcessWinnerConvergenceError(
      daemonDir,
      reason,
      generationId,
      `Winner generation ${generationId} for "${daemonDir}" did not converge to ready (${reason}: ${detail})`,
      cause !== undefined ? { cause } : undefined,
    );
  };

  // Phase 1282 Step C：deadline/poll 调度由 ready-convergence 原语唯一拥有；
  // 本观察器只解释 foreign winner 的磁盘事实与终局（typed failure + audit）。
  const observe = (): ConvergenceObservation<EnsureRunningOutcome> => {
    const spawning = inspectSpawning(ctx, daemonDir);
    if (spawning.status === 'malformed') {
      throw new ProcessGenerationStateError(daemonDir, 'spawning', 'inspect', spawning.cause);
    }

    if (spawning.status === 'ok' && spawning.record.generation_id === generationId) {
      const failure = inspectSpawningFailure(ctx, daemonDir);
      if (failure.status === 'malformed') {
        throw new ProcessGenerationStateError(daemonDir, 'spawning', 'inspect', failure.cause);
      }
      if (failure.status === 'ok') {
        fail('winner_failed', `failure fact: ${failure.record.reason}`);
      }
      const pid = inspectSpawningPid(ctx, daemonDir);
      if (pid.status === 'malformed') {
        throw new ProcessGenerationStateError(daemonDir, 'spawning', 'inspect', pid.cause);
      }
      const ready = inspectSpawningReady(ctx, daemonDir);
      if (ready.status === 'malformed') {
        throw new ProcessGenerationStateError(daemonDir, 'spawning', 'inspect', ready.cause);
      }
      if (ready.status === 'ok') {
        // child 已写 ready、activate 即将发生；probe 系统故障（非 ESRCH）不归 winner_died
        const probe = probeWinnerAlive(
          ctx,
          ready.record.pid,
          ready.record.start_time ?? (pid.status === 'ok' ? pid.record.start_time : undefined),
        );
        if (probe.kind === 'unavailable') {
          fail('winner_probe_unavailable', `winner probe unavailable: ${formatErr(probe.error)}`, probe.error);
        }
        const alive =
          pid.status === 'ok' &&
          pid.record.generation_id === generationId &&
          pid.record.pid === ready.record.pid &&
          probe.kind === 'alive';
        if (!alive) {
          fail('winner_died', 'winner wrote ready fact in spawning but process is not alive');
        }
      }
      // 其余情况：spawning 合法窗口（PID/ready 未齐）→ 继续等待
      return { kind: 'pending' };
    }

    const active = inspectActive(ctx, daemonDir);
    if (active.status === 'malformed') {
      throw new ProcessGenerationStateError(daemonDir, 'active', 'inspect', active.cause);
    }
    if (active.status === 'ok' && active.record.generation_id === generationId) {
      const pid = inspectActivePid(ctx, daemonDir);
      if (pid.status === 'malformed') {
        throw new ProcessGenerationStateError(daemonDir, 'active', 'inspect', pid.cause);
      }
      const ready = inspectActiveReady(ctx, daemonDir);
      if (ready.status === 'malformed') {
        throw new ProcessGenerationStateError(daemonDir, 'active', 'inspect', ready.cause);
      }
      if (
        pid.status === 'ok' &&
        pid.record.generation_id === generationId &&
        ready.status === 'ok' &&
        ready.record.generation_id === generationId &&
        pid.record.pid === ready.record.pid
      ) {
        // phase 1775：probe 系统故障（非 ESRCH）不归 winner_died——误判 dead 会
        // 在 foreign winner 实际存活时触发 respawn/double-spawn。
        const probe = probeWinnerAlive(ctx, pid.record.pid, pid.record.start_time ?? ready.record.start_time);
        if (probe.kind === 'unavailable') {
          fail('winner_probe_unavailable', `winner probe unavailable: ${formatErr(probe.error)}`, probe.error);
        }
        if (probe.kind === 'dead') {
          fail('winner_died', 'winner active facts complete but process is not alive');
        }
        ctx.audit.write(
          PROCESS_MANAGER_AUDIT_EVENTS.ENSURE_JOINED,
          `daemon_dir=${daemonDir}`,
          `generation=${generationId}`,
          `pid=${pid.record.pid}`,
          `duration_ms=${Date.now() - joinStart}`,
        );
        return { kind: 'ready', value: { kind: 'joined', pid: pid.record.pid, generationId } };
      }
      // active 事实未齐（move 中途的瞬时视角）→ 继续等待
      return { kind: 'pending' };
    }

    const retired = inspectRetiredGeneration(ctx, daemonDir, generationId);
    if (retired.status === 'ok') {
      const failure = inspectRetiredFailure(ctx, daemonDir, generationId);
      if (failure.status === 'ok') {
        fail('winner_failed', `retired with failure fact: ${failure.record.reason}`);
      }
      fail('winner_retired', `generation retired (${retired.record.generation_id})`);
    }
    if (retired.status === 'malformed') {
      // 位置事实优先：generation 确在 retired/，record 损坏不升级为状态损坏
      fail('winner_retired', 'generation retired (record unreadable)');
    }
    if (active.status === 'ok') {
      fail('winner_replaced', `active slot held by generation ${active.record.generation_id}`);
    }
    if (spawning.status === 'ok') {
      fail('winner_replaced', `spawning slot held by generation ${spawning.record.generation_id}`);
    }
    return fail('winner_vanished', 'generation absent from spawning/active/retired');
  };

  return awaitReadyConvergence(observe, () => {
    const detail = `winner not ready within ${BOOT_DEADLINE_MS}ms`;
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.ENSURE_FAILED,
      `daemon_dir=${daemonDir}`,
      `generation=${generationId}`,
      `reason=join_timeout`,
      `detail=${ctx.audit.message(detail)}`,
    );
    return new ProcessWinnerConvergenceError(
      daemonDir,
      'join_timeout',
      generationId,
      `Winner generation ${generationId} for "${daemonDir}" did not converge to ready (join_timeout: ${detail})`,
    );
  });
}
