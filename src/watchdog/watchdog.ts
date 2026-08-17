/**
 * @module L6.Watchdog
 * @layer L6 进程边界（Watchdog 守护进程）
 * @depends L1.FileSystem, L2.AuditLog, L2.Messaging, L2.ProcessManager, L6.CLI
 * @consumers L6.CLI（spawn）
 * @contract design/modules/l6_watchdog.md
 *
 * Watchdog 守护进程 — 每 30s 检查 motion 存活 / 内建简易 cron。
 *
 * 内部物理拆 sub-file：
 * - watchdog-context.ts   module-level durable state + getter/setter
 * - watchdog-pid.ts       PID file mgmt
 * - watchdog-log.ts       log + audit helpers
 * - watchdog-state.ts     state 持久化
 * - executor-recovery.ts  per-claw daemon availability recovery
 * - spawn.ts             spawnWatchdogCandidate（spawn + poll 原语，不含 CLI）
 *
 * 本 file 保：runWatchdogLoop（main loop）+ shutdownWatchdog（graceful stop）+ barrel re-export
 */


import * as path from 'path';
import { formatErr } from "../foundation/node-utils/index.js";
import { setTimeout } from 'timers/promises';

import {
  resolveClawDaemonDir,
  MOTION_CLAW_ID,
  enumerateClaws,
  getWorkspaceRoot,
  getChestnutRoot,
  getNamedSubrootDir,
} from '../core/claw-topology/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import { type AuditLog, createWorkspaceAudit, createHourlyHeartbeatAccumulator } from '../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../foundation/process-manager/index.js';
import { ProcessSpawnConflictError } from '../foundation/process-manager/index.js';
import { WATCHDOG_AUDIT_EVENTS, WATCHDOG_FILE_ROUTING } from './audit-events.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../foundation/process-manager/index.js';

import { resolveDaemonEntry } from '../daemon/index.js';


import {
  getChestnutDir, getChestnutFs, getWatchdogConfig, setAuditWriter, getAuditWriter,
  motionRestartStateAPI, executorRestartStateAPI,
  type MotionRestartState,
} from './watchdog-context.js';
import {
  removeWatchdogPid, removeWatchdogPidIfOwner,
  isWatchdogProcessAlive, disposLegacyWatchdogPid, WatchdogPidForeignWorkspaceError,
} from './watchdog-pid.js';
import {
  newWatchdogAttempt, prepareCandidate, commitOwnership, retireOwnership,
  writeCandidateOutcome, inspectActive, recordGenerationTerminal, WATCHDOG_ACTIVE_DIR,
  type WatchdogOwnership, type WatchdogOwnerRecord, type WatchdogGenerationTerminal,
} from './watchdog-ownership.js';
import {
  log, logWithAudit,
} from './watchdog-log.js';
import {
  loadWatchdogState, saveWatchdogState,
} from './watchdog-state.js';
import {
  decideMotionRestart,
  reduceMotionRestartOutcome,
  type MotionSpawnOutcome,
} from './motion-restart-state.js';
import { maybeCronExecutorRecovery } from './executor-recovery.js';

/**
 * Watchdog motion restart exponential backoff cap（ms）= 5 minutes.
 * Derivation: 5 * 60 * 1000 = 300_000ms / 配 WATCHDOG_MAX_RESTART_DEFAULT=10 即最坏总 retry budget
 * = 10 × 5min = 50min / 与 LLM_RETRY_MAX_DELAY_MS=300s 同值同类 cap exponential backoff /
 * 防无限退避致 motion 永挂 unrecoverable.
 */
const WATCHDOG_BACKOFF_MAX_MS = 5 * 60 * 1000;

/**
 * 连续 motion restart 失败 cap、触顶进 circuit-open（phase 324 H3 立）.
 * Derivation: 10 次重启失败后表 motion 程序态严重问题、继续重启浪费资源 /
 * 配 WATCHDOG_BACKOFF_MAX_MS=5min 即 10 × 5min = 50min 总 retry budget /
 * env WATCHDOG_MAX_RESTART 设有效正整数时覆盖.
 */
const WATCHDOG_MAX_RESTART_DEFAULT = 10;
function getMaxRestart(): number {
  const raw = process.env.WATCHDOG_MAX_RESTART;
  if (!raw) return WATCHDOG_MAX_RESTART_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : WATCHDOG_MAX_RESTART_DEFAULT;
}

// === Ownership (phase 1203 Step B) ===

/** 本子进程 commit 的 ownership 句柄；shutdown 凭它只 retire 自身 generation */
let currentOwnership: WatchdogOwnership | null = null;

/** Test-only: 设置/清除 ownership 句柄（模拟旧 generation 迟到 shutdown） */
export function _setWatchdogOwnershipForTest(ownership: WatchdogOwnership | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setWatchdogOwnershipForTest is for tests only');
  }
  currentOwnership = ownership;
}

export type AcquireWatchdogOwnership =
  | { kind: 'committed'; ownership: WatchdogOwnership }
  | { kind: 'lost'; owner: WatchdogOwnerRecord }
  | { kind: 'foreign_owned'; owner: WatchdogOwnerRecord }
  | { kind: 'legacy_live'; pid: number }
  | { kind: 'failed'; error: unknown };

function writeOutcomeBestEffort(
  fsFactory: (baseDir: string) => FileSystem,
  attemptId: string,
  outcome: Parameters<typeof writeCandidateOutcome>[2],
): void {
  try {
    writeCandidateOutcome(getChestnutFs(fsFactory), attemptId, outcome);
  } catch (err) {
    log(fsFactory, `[watchdog] Failed to write candidate outcome: ${formatErr(err)}`);
  }
}

function ownershipFromRecord(record: WatchdogOwnerRecord): WatchdogOwnership {
  return {
    attemptId: record.attempt_id,
    ownerToken: record.owner_token,
    pid: record.pid,
    activeDir: WATCHDOG_ACTIVE_DIR,
    record,
  };
}

/**
 * 子进程 ownership commit 唯一入口（任何监控副作用前调用）。
 * - committed：进入主 loop 的唯一门票；caller 后续写只能用 active 路径。
 * - live owner：同 workspace → lost；foreign → foreign_owned（entry fail-loud）。
 * - dead owner（含 PID-reuse argv 不符）：不按 workspace 区分，只按其完整 generation
 *   identity（attempt/token/pid）generation-guarded retire 后重试一次 commit。
 * - retryable failure → failed（不伪装 loser；进程退出后由下一 candidate 判死并 retire）。
 */
export function acquireWatchdogOwnership(
  fsFactory: (baseDir: string) => FileSystem,
): AcquireWatchdogOwnership {
  const fs = getChestnutFs(fsFactory);
  const attempt = newWatchdogAttempt(process.pid);
  prepareCandidate(fs, attempt);

  // Phase 1203 Step D: 无 active owner 时先处置 legacy watchdog.pid ——
  // live 保守阻止接管；dead/corrupt 保留证据迁移后放行；文件不得直接删除。
  if (inspectActive(fs).status === 'none') {
    const legacy = disposLegacyWatchdogPid(fsFactory);
    if (legacy.kind === 'foreign_live') {
      writeOutcomeBestEffort(fsFactory, attempt.attempt_id, {
        outcome: 'failed',
        reason: `legacy_foreign_live:${legacy.pid}`,
      });
      throw new WatchdogPidForeignWorkspaceError(legacy.pid, legacy.root, getWorkspaceRoot());
    }
    if (legacy.kind === 'live') {
      writeOutcomeBestEffort(fsFactory, attempt.attempt_id, {
        outcome: 'lost',
        winner_pid: legacy.pid,
        reason: 'legacy_live',
      });
      return { kind: 'legacy_live', pid: legacy.pid };
    }
    if (legacy.kind === 'unreadable') {
      writeOutcomeBestEffort(fsFactory, attempt.attempt_id, {
        outcome: 'failed',
        reason: `legacy_unreadable:${formatErr(legacy.cause)}`,
      });
      return { kind: 'failed', error: legacy.cause };
    }
  }

  let commit = commitOwnership(fs, attempt);

  if (commit.kind === 'foreign_owned') {
    const owner = commit.owner;
    if (isWatchdogProcessAlive(owner.pid)) {
      // live owner：同 workspace → lost；foreign → fail-loud（不赋予 live foreign 覆盖权）
      if (owner.workspace_root !== getWorkspaceRoot()) {
        return { kind: 'foreign_owned', owner };
      }
    } else {
      // dead owner（含 PID-reuse argv 不符）：无论历史 workspace，只按磁盘 record 的
      // 完整 generation identity retire，不用当前 candidate identity。
      log(fsFactory, `[watchdog] stale owner (PID=${owner.pid}) detected, retiring before commit...`);
      // Phase 1247 Step B: 先补记 unclean terminal，再 generation-guarded retire；
      // terminal 写失败时保留 active 证据，不伪装成功继续 commit。
      const terminal: WatchdogGenerationTerminal = {
        kind: 'unclean',
        detected_at: new Date().toISOString(),
        detected_by_pid: process.pid,
      };
      const terminalResult = recordGenerationTerminal(
        fs,
        { attemptId: owner.attempt_id, ownerToken: owner.owner_token, pid: owner.pid },
        terminal,
      );
      const auditWriter = getAuditWriter();
      if (terminalResult.kind === 'failed' || terminalResult.kind === 'malformed') {
        auditWriter?.write(
          WATCHDOG_AUDIT_EVENTS.WATCHDOG_TERMINAL_WRITE_FAILED,
          `ctx=stale_recovery`,
          `attempt=${owner.attempt_id}`,
          `token=${owner.owner_token}`,
          `pid=${owner.pid}`,
          `error=${auditWriter?.message(formatErr(terminalResult.cause)) ?? formatErr(terminalResult.cause)}`,
        );
        return { kind: 'failed', error: terminalResult.cause };
      }
      if (terminalResult.kind === 'recorded') {
        auditWriter?.write(
          WATCHDOG_AUDIT_EVENTS.WATCHDOG_UNCLEAN_TERMINATION_DETECTED,
          `attempt=${owner.attempt_id}`,
          `token=${owner.owner_token}`,
          `pid=${owner.pid}`,
          `detected_by_pid=${process.pid}`,
        );
      }
      const retired = retireOwnership(
        fs,
        { attemptId: owner.attempt_id, ownerToken: owner.owner_token, pid: owner.pid },
        'stale_recovery',
      );
      if (retired.kind === 'retired' || retired.kind === 'collision' || retired.kind === 'no_active') {
        commit = commitOwnership(fs, attempt);
      }
    }
    if (commit.kind === 'foreign_owned') {
      writeOutcomeBestEffort(fsFactory, attempt.attempt_id, {
        outcome: 'lost',
        winner_owner_token: commit.owner.owner_token,
        winner_pid: commit.owner.pid,
        reason: 'active_occupied',
      });
      return { kind: 'lost', owner: commit.owner };
    }
  }

  if (commit.kind === 'committed') return { kind: 'committed', ownership: commit.ownership };
  if (commit.kind === 'already_owned') return { kind: 'committed', ownership: ownershipFromRecord(commit.owner) };

  // retryable_failure：留 failed outcome，不伪装 loser
  writeOutcomeBestEffort(fsFactory, attempt.attempt_id, {
    outcome: 'failed',
    reason: `commit_retryable_failure:${formatErr(commit.cause)}`,
  });
  return { kind: 'failed', error: commit.cause };
}

// === Shutdown (21 行) ===

/** Module-level guard: prevent reentrant shutdown when SIGTERM + SIGINT both fire */
let shuttingDown = false;
let sigtermHandler: (() => void) | null = null;
let sigintHandler: (() => void) | null = null;

/** Test-only: reset shutdown guard between tests */
export function _resetShutdownGuard(): void {
  shuttingDown = false;
  if (sigtermHandler) {
    process.removeListener('SIGTERM', sigtermHandler);
    sigtermHandler = null;
  }
  if (sigintHandler) {
    process.removeListener('SIGINT', sigintHandler);
    sigintHandler = null;
  }
}

/** 1:1 保 watchdog.ts:100-120 */
export function shutdownWatchdog(
  fsFactory: (baseDir: string) => FileSystem,
  auditWriter: AuditLog,
  signal: string,
): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(fsFactory, `[watchdog] Received ${signal}, shutting down...`);
  // Phase 1247 Step B: 在 retire 前写 stopped terminal；best-effort，失败仍继续 shutdown。
  if (currentOwnership && (signal === 'SIGTERM' || signal === 'SIGINT')) {
    const terminal: WatchdogGenerationTerminal = {
      kind: 'stopped',
      signal,
      recorded_at: new Date().toISOString(),
    };
    const terminalResult = recordGenerationTerminal(
      getChestnutFs(fsFactory),
      {
        attemptId: currentOwnership.attemptId,
        ownerToken: currentOwnership.ownerToken,
        pid: currentOwnership.pid,
      },
      terminal,
    );
    if (terminalResult.kind === 'recorded') {
      auditWriter.write(
        WATCHDOG_AUDIT_EVENTS.WATCHDOG_TERMINAL_RECORDED,
        `attempt=${currentOwnership.attemptId}`,
        `token=${currentOwnership.ownerToken}`,
        `kind=stopped`,
        `signal=${signal}`,
      );
    }
  }
  let saveFailed: string | undefined;
  try {
    saveWatchdogState(fsFactory);
  } catch (err) {
    saveFailed = formatErr(err);
    log(fsFactory, `[watchdog] Failed to save state: ${saveFailed}`);
  }
  removeWatchdogPidLegacy(fsFactory);
  if (saveFailed) {
    auditWriter.write(WATCHDOG_AUDIT_EVENTS.STOP, `signal=${signal}`, `save_failed=${auditWriter.message(saveFailed)}`);
  } else {
    auditWriter.write(WATCHDOG_AUDIT_EVENTS.STOP, `signal=${signal}`);
  }
  // phase 518 (review-round4 CLI M、phase 477 gap 补完): shutdownWatchdog exit 前
  // dispose audit、flush batched buffer 防 telemetry 丢
  auditWriter.dispose?.();
  process.exit(saveFailed ? 1 : 0);
}

/** shutdown 的 PID/ownership 处置：有 ownership 句柄 → generation guard；无句柄 → legacy 旧行为 */
function removeWatchdogPidLegacy(fsFactory: (baseDir: string) => FileSystem): void {
  if (currentOwnership) {
    const fs = getChestnutFs(fsFactory);
    const retired = retireOwnership(
      fs,
      {
        attemptId: currentOwnership.attemptId,
        ownerToken: currentOwnership.ownerToken,
        pid: currentOwnership.pid,
      },
      'shutdown',
    );
    if (retired.kind !== 'retired' && retired.kind !== 'no_active') {
      // 旧 generation 迟到 shutdown 命中 fresh active / 他 reclaimer 已处置 → 不动磁盘
      log(fsFactory, `[watchdog] ownership retire skipped (kind=${retired.kind})`);
    }
    removeWatchdogPidIfOwner(fsFactory, currentOwnership.pid);
    return;
  }
  removeWatchdogPid(fsFactory);
}

// === Motion restart helper ===

async function attemptMotionRestart(
  pm: ReturnType<typeof createProcessManagerForCLI>,
  fsFactory: (baseDir: string) => FileSystem,
  audit: AuditLog,
  status: ReturnType<ReturnType<typeof createProcessManagerForCLI>['getAliveStatus']>,
  daemonLogName: string,
): Promise<MotionSpawnOutcome> {
  log(fsFactory, `[watchdog] motion down (${status.reason}), restarting...`);
  // phase 601: 裸 MOTION_CLAW_ID 改 key=value 形态 + 加 reason col、与其他 watchdog emit 对齐
  audit.write(WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_TRIGGERED, `claw=${MOTION_CLAW_ID}`, `reason=${status.reason}`);
  // phase 430 Step B: 删除重复 log call (history merge artifact、motion-down 写两遍)

  try {
    // best-effort cleanup before respawn / per phase 636 ratify:
    //   - cleanup failure 可能源:
    //     (a) 真 stale PID 文件 → safe to ignore (audit captures)
    //     (b) motion 仍活（race / 另 watchdog instance spawn 中）→ spawn 抛 ProcessSpawnConflictError、捕获后 reset 计数
    //   - cleanup 失败不阻塞 respawn / spawn 自身判 race / failure 仅 audit observability
    await pm.stop(resolveClawDaemonDir(MOTION_CLAW_ID)).catch((e) => {
      const msg = `[watchdog] Failed to clean up motion before restart: ${formatErr(e)}`;
      // phase 718: payload 加 message= prefix、forensic 解析可 join message 维度
      logWithAudit(fsFactory, msg, WATCHDOG_AUDIT_EVENTS.CLEANUP_FAILED, `message=${audit.message(msg)}`);
    });
    const daemonEntryPath = resolveDaemonEntry();
    const pid = await pm.spawn(resolveClawDaemonDir(MOTION_CLAW_ID), {
      command: 'node',
      args: [daemonEntryPath, MOTION_CLAW_ID],
      logFile: path.join(getNamedSubrootDir('motion'), daemonLogName),
      // phase 422 Step B (review medium orphan-cleanup uniformity): 与 motion.ts:209
      // / start.ts / claw-chat (phase 398 N1) 全 CLI 入口对齐、不绕
      // makeChestnutRoot/path.dirname。
      env: { ...process.env, CHESTNUT_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
      // phase 458 (review N3-M): 显式传 cwd 防子进程继承 watchdog process.cwd（test/multi-workspace
      // 污染风险）。motion 子进程逻辑通过 CHESTNUT_ROOT env 寻路、cwd 应为 chestnut workspace root。
      cwd: getWorkspaceRoot(),
    });
    log(fsFactory, `[watchdog] motion restarted (PID=${pid})`);
    // phase 716: raw MOTION_CLAW_ID 加 claw= prefix、与 spawn.ts:351 同 event 形态对齐
    audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED, `claw=${MOTION_CLAW_ID}`, `pid=${pid}`);
    return { kind: 'spawned', pid };
  } catch (err) {
    if (err instanceof ProcessSpawnConflictError) {
      // phase 324 H3 锚 + Phase 1235：合法 spawn ownership conflict 重置 failures 是
      // intentional —— 另一实例赢了 race、不是本机 motion spawn 失败，所以不入失败计数。
      // malformed generation（ProcessGenerationStateError）不属于此类，走 failed/backoff。
      log(fsFactory, `[watchdog] motion already started by another instance`);
      return { kind: 'spawn_conflict', reason: err.reason };
    }
    // phase 716: raw MOTION_CLAW_ID 加 claw= prefix、与 spawn.ts:370 同 event 形态对齐
    audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED, `claw=${MOTION_CLAW_ID}`, `error=${formatErr(err)}`);
    log(fsFactory, `[watchdog] FAILED to restart motion: ${err}`);
    return { kind: 'failed', error: err };
  }
}

// === Main loop ===

/**
 * 1:1 保 watchdog.ts:402-513
 *
 * @param fsFactory 文件系统工厂
 * @param daemonLogName daemon stdout 日志文件相对名（phase 1364 ratify daemon 单 owner、装配 caller setter 注入；phase 444 Step B DI 化避免 watchdog→daemon 模块边）
 */
export async function runWatchdogLoop(
  fsFactory: (baseDir: string) => FileSystem,
  daemonLogName: string,
): Promise<void> {
  log(fsFactory, '[watchdog] Daemon starting...');

  // 先建 auditWriter，让 ownership commit 与 loadWatchdogState corrupt 路径可写 audit（N1 修复）
  // Phase 1288 Step C: 构造委托 AuditLog 自家 createWorkspaceAudit（固定写 audit/audit.tsv、
  // retention 自 AuditLog config store 自读）；Watchdog 不再接触路径 / maxSizeMb / Assembly config
  const auditWriter = createWorkspaceAudit(fsFactory, getChestnutDir(), WATCHDOG_FILE_ROUTING);
  setAuditWriter(auditWriter);

  // Phase 1203 Step B: 子进程在任何监控副作用（state load / WATCHDOG_START /
  // signal / timer / motion restart）前必须 commit 目录 ownership；
  // loser 在零副作用后退出，failure 不伪装 loser（由下一 candidate 判死 retire）。
  const acquisition = acquireWatchdogOwnership(fsFactory);
  if (acquisition.kind === 'lost' || acquisition.kind === 'legacy_live') {
    const detail = acquisition.kind === 'lost'
      ? `active already owned (PID=${acquisition.owner.pid})`
      : `legacy watchdog alive (PID=${acquisition.pid})`;
    log(fsFactory, `[watchdog] ${detail}, exiting before any side effect.`);
    auditWriter.dispose?.();
    return;
  }
  if (acquisition.kind === 'foreign_owned') {
    // live foreign owner：fail-loud（entry unhandledRejection → crash audit + exit 1）
    auditWriter.dispose?.();
    throw new WatchdogPidForeignWorkspaceError(
      acquisition.owner.pid,
      acquisition.owner.workspace_root,
      getWorkspaceRoot(),
    );
  }
  if (acquisition.kind === 'failed') {
    auditWriter.dispose?.();
    throw new Error(`watchdog ownership commit failed: ${formatErr(acquisition.error)}`);
  }
  currentOwnership = acquisition.ownership;

  // Phase 1203 Step E: 不写 `watchdog.pid` —— active/owner.json 是唯一 current owner 事实；
  // legacy pid 文件只作升级前输入读取/判活/迁移/stop 兼容清理。
  loadWatchdogState(fsFactory);   // 恢复通知状态（_auditWriter 已设，corrupt 路径可写 audit）
  log(fsFactory, '[watchdog] State loaded.');

  auditWriter.write(WATCHDOG_AUDIT_EVENTS.WATCHDOG_START);

  let stopped = false;

  // Create Motion ProcessManager (reused across loop iterations)
  const baseDir = getChestnutRoot();
  const pm = createProcessManagerForCLI({ fsFactory, baseDir });

  // phase 1034: idempotent install / 防 test re-entry 或 production 异常 re-entry 累 listener (Node maxListeners warning)
  // mirror _resetShutdownGuard removeListener pattern (line 60-66) — install 前 cleanup prior
  if (sigtermHandler) process.removeListener('SIGTERM', sigtermHandler);
  if (sigintHandler) process.removeListener('SIGINT', sigintHandler);

  sigtermHandler = () => {
    stopped = true;
    shutdownWatchdog(fsFactory, auditWriter, 'SIGTERM');
  };
  sigintHandler = () => {
    stopped = true;
    shutdownWatchdog(fsFactory, auditWriter, 'SIGINT');
  };
  process.on('SIGTERM', sigtermHandler);
  process.on('SIGINT', sigintHandler);

  const maxRestart = getMaxRestart();

  const hourlyHeartbeat = createHourlyHeartbeatAccumulator({
    onHourly: (tickCount, elapsedMs) => {
      auditWriter.write(
        WATCHDOG_AUDIT_EVENTS.HEARTBEAT_HOURLY,
        `ticks=${tickCount}`,
        `elapsed_ms=${elapsedMs}`,
        `alive=${aliveIds.join(',')}`,
        `present=${presentClawIds.join(',')}`,
      );
    },
  });

  let aliveIds: string[] = [];
  let presentClawIds: string[] = [];

  while (!stopped) {
    const now = Date.now();
    // 1. Check motion liveness
    const status = pm.getAliveStatus(resolveClawDaemonDir(MOTION_CLAW_ID));

    // watchdog_check: 枚举所有存活进程
    aliveIds = [];
    presentClawIds = [];
    if (status.alive) aliveIds.push(MOTION_CLAW_ID);
    const fs = getChestnutFs(fsFactory);
    try {
      for (const rawClawId of enumerateClaws(fs, 'claws')) {
        presentClawIds.push(rawClawId);
        if (pm.getAliveStatus(resolveClawDaemonDir(makeClawId(rawClawId))).alive) aliveIds.push(rawClawId);
      }
    } catch (err) {
      if (!isFileNotFound(err)) {
        // phase 697: 加 dir col、与 phase 696 SUBSCRIPTION_DIR_LIST_FAILED + ARCHIVE_DIR_FAILED 对齐
        auditWriter.write(
          WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED,
          `ctx=watchdog_tick`,
          `dir=claws`,
          `error=${formatErr(err)}`,
        );
      }
      // ENOENT = no claws present / 其他错 audit / treat as empty（下 tick 重试）
    }
    // phase 690: 拆 alive + present 为两独立 col、修 audit.tsv tab-分隔下单 col 含两 key=value
    // 解析失真（按 = 拆时第 2 key=value 被吞入首 col 的 value）
    auditWriter.write(
      WATCHDOG_AUDIT_EVENTS.WATCHDOG_CHECK,
      `alive=${aliveIds.join(',')}`,
      `present=${presentClawIds.join(',')}`,
    );
    hourlyHeartbeat.tick(now);

    const intervalMs = getWatchdogConfig(fsFactory).interval_ms;
    const prior = motionRestartStateAPI.snapshot();
    const decision = decideMotionRestart(prior, status.alive, now, maxRestart);
    motionRestartStateAPI.replace(decision.state);

    let nextSleepMs = intervalMs;
    switch (decision.action) {
      case 'healthy':
        if (prior.status === 'open') {
          // phase 723 + 1164: circuit-open → closed recovery
          log(fsFactory, '[watchdog] motion is alive again, reopening circuit');
          auditWriter.write(
            WATCHDOG_AUDIT_EVENTS.WATCHDOG_CIRCUIT_REOPENED,
            `reason=motion_alive_again`,
            `prev_failures=${decision.recoveredAttempts}`,
          );
        } else if (decision.recoveredAttempts > 0) {
          // phase 1164: spawn success survived until next tick
          auditWriter.write(
            WATCHDOG_AUDIT_EVENTS.WATCHDOG_MOTION_STABILITY_CONFIRMED,
            `previous_attempts=${decision.recoveredAttempts}`,
          );
        }
        break;
      case 'defer': {
        const retryingState = decision.state as Extract<MotionRestartState, { status: 'retrying' }>;
        nextSleepMs = Math.max(0, Math.min(decision.waitMs, WATCHDOG_BACKOFF_MAX_MS));
        auditWriter.write(
          WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_DEFERRED,
          `consecutive_attempts=${retryingState.consecutiveAttempts}`,
          `next_attempt_at=${retryingState.nextAttemptAt}`,
        );
        break;
      }
      case 'circuit_open':
        nextSleepMs = WATCHDOG_BACKOFF_MAX_MS;
        if (decision.justOpened) {
          auditWriter.write(
            WATCHDOG_AUDIT_EVENTS.WATCHDOG_GAVE_UP,
            `consecutive_failures=${decision.state.consecutiveAttempts}`,
            `cap=${maxRestart}`,
            `reason=motion_restart_unstable`,
          );
          log(
            fsFactory,
            `[watchdog] gave up restarting motion after ${decision.state.consecutiveAttempts} consecutive failures (cap=${maxRestart}); ` +
            `entering circuit-open. Restart watchdog manually after fixing motion.`,
          );
        }
        break;
      case 'attempt': {
        const outcome = await attemptMotionRestart(pm, fsFactory, auditWriter, status, daemonLogName);
        const next = reduceMotionRestartOutcome(
          decision.state, outcome, Date.now(), intervalMs, WATCHDOG_BACKOFF_MAX_MS,
        );
        motionRestartStateAPI.replace(next);
        nextSleepMs =
          next.status === 'retrying'
            ? Math.max(0, Math.min(next.nextAttemptAt - Date.now(), WATCHDOG_BACKOFF_MAX_MS))
            : intervalMs;
        break;
      }
    }

    // Persist restart transitions before cron/sleep may fail.
    saveWatchdogState(fsFactory);

    // 2. Executor availability recovery (Phase 1396 Step F/H)
    const nextExecutorMap = await maybeCronExecutorRecovery(
      executorRestartStateAPI.snapshot(),
      { pm, audit: auditWriter, fsFactory, daemonLogName },
    );
    executorRestartStateAPI.replace(nextExecutorMap);
    saveWatchdogState(fsFactory);

    // 3. Sleep with backoff on consecutive failures (max 5 minutes) — or circuit-open idle
    await setTimeout(nextSleepMs);
  }
}
