/**
 * @module L6.Watchdog.Cron
 * Watchdog cron jobs — claw crash detection + auto-restart
 *
 * phase 1383 (P2b): claw_inactivity 超时检测/subscription/通知退场——
 * 停滞自活归 daemon 内化（in-process waiting-stall + Step D 心跳文件兜底），
 * Watchdog 只留进程死活 + 崩溃自愈（心跳过期重启在 Step D 加）。
 */


import * as path from 'path';
import { formatErr } from "../foundation/node-utils/index.js";
import type { FileSystem } from '../foundation/fs/index.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import { ProcessSpawnConflictError, PROCESS_MANAGER_AUDIT_EVENTS } from '../foundation/process-manager/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import {
  getChestnutDir, getChestnutFs, getWatchdogConfig,
  clawStateAPI, clawRestartStateAPI,
} from './watchdog-context.js';
import { log, logWithAudit } from './watchdog-log.js';
import { clawHasActiveContract, deriveCrashClass, hasCleanStopMarker, WATCHDOG_BACKOFF_MAX_MS, getWatchdogMaxRestart } from './watchdog-utils.js';
import {
  decideDaemonRestart, reduceMotionRestartOutcome, type MotionSpawnOutcome,
} from './motion-restart-state.js';
import { HEARTBEAT_STALE_TIMEOUT_MS } from './constants.js';

import {
  enumerateClaws,
  getRelativeClawDir,
  getWorkspaceRoot,
  resolveClawDaemonDir,
} from '../core/claw-topology/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import { resolveDaemonEntry, DAEMON_LOG } from '../daemon/index.js';


/**
 * phase 138: watchdog-cron Map cleanup 全路径覆盖（audit.P1.wd-1）
 *
 * 移除 Map/SetStore 中不在 existingClawIds 的 entry。
 * existingClawIds = 空集时清全部（CLAWS_DIR 不存在 = no claws present）。
 */
function pruneStaleMapEntries(
  map: { keys(): IterableIterator<string>; delete(k: string): boolean },
  existingClawIds: Set<string>,
): void {
  for (const id of map.keys()) {
    if (!existingClawIds.has(id)) {
      map.delete(id);
    }
  }
}

// Detect claw process crashes (dead daemon with active contract) and restart it.
// phase 1380: 检测 → decideDaemonRestart 状态机 → attemptClawRestart（backoff + 熔断）。
//   - 触发条件 = dead + activeContract（不再要求 !notified —— dedup 机制被状态机替换）
//   - legacy paused contract 永不处理（与 phase 1482 inactivity-legacy-paused-skip 一致）
//   - crash_class 保留为纯审计事实（DP1 死因记录）、不进任何决策
//   - 熔断（连续失败达上限）= circuit-open 持久化 + audit；契约收尾不归本模块（P2 同根机制治理）
export async function maybeCronClawCrash(pm: ProcessManager, audit: AuditLog, fsFactory: (baseDir: string) => FileSystem): Promise<void> {
  const fs = getChestnutFs(fsFactory);
  // 枚举 claws 并清理已不存在的 claw 的 Map 条目
  let clawNames: string[];
  try {
    clawNames = enumerateClaws(fs, 'claws');
  } catch (err) {
    if (isFileNotFound(err)) {
      // phase 138: claws dir 不存在 = no claws present、cleanup 全部 stale entries（audit.P1.wd-1 真治）
      const emptyExisting = new Set<string>();
      pruneStaleMapEntries(clawStateAPI.clawPreviouslyAlive, emptyExisting);
      pruneStaleMapEntries(clawStateAPI.everSpawned, emptyExisting);
      clawRestartStateAPI.pruneStale(emptyExisting);
      return;
    }
    // phase 697: 加 dir col、与 phase 696 SUBSCRIPTION_DIR_LIST_FAILED + ARCHIVE_DIR_FAILED 对齐
    audit.write(
      WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED,
      `ctx=crash`,
      `dir=claws`,
      `error=${formatErr(err)}`,
    );
    return;  // 其他错 = treat as no claws、下 tick 重试
  }
  const existingClawIds = new Set(clawNames);
  // phase 691: 拆 ctx + present 为两独立 col、与 phase 690 WATCHDOG_CHECK 同模式修正
  audit.write(
    WATCHDOG_AUDIT_EVENTS.CLAW_SCAN,
    `ctx=crash`,
    `present=${[...existingClawIds].join(',')}`,
  );
  pruneStaleMapEntries(clawStateAPI.clawPreviouslyAlive, existingClawIds);
  pruneStaleMapEntries(clawStateAPI.everSpawned, existingClawIds);
  // legacy dedup 字段（phase 1380 起无决策消费者）仍随 state.json 持久化、同步清理防 stale 累积
  pruneStaleMapEntries(clawStateAPI.clawPreviouslyNotified, existingClawIds);
  clawRestartStateAPI.pruneStale(existingClawIds);

  const maxRestart = getWatchdogMaxRestart();
  const intervalMs = getWatchdogConfig(fsFactory).interval_ms;

  for (const rawClawId of clawNames) {
    const clawId = rawClawId;
    const clawDir = path.join(getChestnutDir(), getRelativeClawDir(rawClawId));
    const currentlyAlive = pm.getAliveStatus(resolveClawDaemonDir(makeClawId(clawId))).alive;

    if (currentlyAlive) {
      clawStateAPI.everSpawned.add(rawClawId);
      // phase 1380: alive 恢复 → 清 restart 状态（跨 episode 计数归零、与 motion 恢复同语义）
      if (clawRestartStateAPI.get(rawClawId) !== undefined) {
        clawRestartStateAPI.delete(rawClawId);
        audit.write(
          WATCHDOG_AUDIT_EVENTS.CLAW_RESTART_RECOVERED,
          `claw=${rawClawId}`,
        );
      }
    }

    if (!currentlyAlive) {
      // legacy paused contract 永不处理 (clawHasActiveContract 内部已 active-only)
      if (!clawHasActiveContract(clawDir, fsFactory, audit)) {
        // phase 133: B1 silent skip 加 audit emit（DP「不丢弃静默」+ 三分判定每分支必 audit）
        audit.write(
          WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_SKIPPED_NO_CONTRACT,
          `claw=${rawClawId}`,
          `reason=no_active_contract`,
        );
        clawStateAPI.clawPreviouslyAlive.set(rawClawId, currentlyAlive);
        continue;
      }

      const now = Date.now();
      await runClawRestartStateMachine({
        pm, fsFactory, audit,
        clawId: rawClawId, clawDir,
        reason: 'crash_detected',
        daemonAlive: false,
        now, maxRestart, intervalMs,
      });
    }

    clawStateAPI.clawPreviouslyAlive.set(clawId, currentlyAlive);
  }
}

/**
 * phase 1380/Step D: 单 claw 重启状态机推进 —— crash 检测（进程死）与
 * heartbeat-stale（进程活但事件循环全阻塞）共用同一 clawRestartStateAPI 状态机，
 * 不新起一套 backoff。
 *
 * @param daemonAlive 传 false 触发重启决策（crash = 进程死；heartbeat-stale =
 *   进程活但功能死，强制按 dead 推进重启）。
 * @param reason 审计/重启触发原因（crash_detected | heartbeat_stale）。
 */
async function runClawRestartStateMachine(args: {
  pm: ProcessManager;
  fsFactory: (baseDir: string) => FileSystem;
  audit: AuditLog;
  clawId: string;
  clawDir: string;
  reason: 'crash_detected' | 'heartbeat_stale';
  daemonAlive: boolean;
  now: number;
  maxRestart: number;
  intervalMs: number;
}): Promise<void> {
  const { pm, fsFactory, audit, clawId, clawDir, reason, daemonAlive, now, maxRestart, intervalMs } = args;
  const prior = clawRestartStateAPI.get(clawId) ?? { status: 'closed', consecutiveAttempts: 0 };
  const decision = decideDaemonRestart(prior, daemonAlive, now, maxRestart);
  clawRestartStateAPI.set(clawId, decision.state);

  switch (decision.action) {
    case 'attempt': {
      if (reason === 'crash_detected') {
        // crash_class 死因审计（DP1）：clean-stop marker 探测照旧
        const cleanStop = hasCleanStopMarker(clawDir, fsFactory);
        const crashClass = deriveCrashClass({ hasCleanStopMarker: cleanStop });
        audit.write(
          WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
          `claw=${clawId}`,
          `has_contract=true`,
          `crash_class=${crashClass}`,
        );
        log(fsFactory, `[watchdog] Claw ${clawId} ${crashClass}${cleanStop ? ' (clean-stop marker present)' : ' (no marker)'}`);
      } else {
        const staleMs = readHeartbeatAgeMs(clawDir, fsFactory);
        audit.write(
          WATCHDOG_AUDIT_EVENTS.CLAW_HEARTBEAT_STALE,
          `claw=${clawId}`,
          `process_alive=true`,
          `stale_ms=${staleMs ?? 'unknown'}`,
        );
        log(fsFactory, `[watchdog] Claw ${clawId} heartbeat stale (process alive, event loop blocked); restarting...`);
      }

      const outcome = await attemptClawRestart(pm, fsFactory, audit, clawId, reason);
      const next = reduceMotionRestartOutcome(
        prior, outcome, Date.now(), intervalMs, WATCHDOG_BACKOFF_MAX_MS,
      );
      clawRestartStateAPI.set(clawId, next);
      break;
    }
    case 'defer': break;            // 退避窗口内、本 tick 不尝试
    case 'circuit_open': {
      if (decision.justOpened) {
        audit.write(
          WATCHDOG_AUDIT_EVENTS.CLAW_RESTART_CIRCUIT_OPENED,
          `claw=${clawId}`,
          `attempts=${decision.state.consecutiveAttempts}`,
          `cap=${maxRestart}`,
        );
        log(
          fsFactory,
          `[watchdog] gave up restarting claw ${clawId} after ${decision.state.consecutiveAttempts} consecutive failures (cap=${maxRestart}); entering circuit-open.`,
        );
      }
      break;                        // 已放弃、不再每 tick 尝试；契约收尾不归本模块（P2）
    }
    case 'healthy': break;
  }
}

// === Claw restart helper（phase 1380、镜像 attemptMotionRestart / watchdog.ts） ===

async function attemptClawRestart(
  pm: ProcessManager,
  fsFactory: (baseDir: string) => FileSystem,
  audit: AuditLog,
  clawId: string,
  reason: 'crash_detected' | 'heartbeat_stale',
): Promise<MotionSpawnOutcome> {
  const reasonText = reason === 'crash_detected' ? 'down, restarting...' : 'event loop blocked (heartbeat stale), restarting...';
  log(fsFactory, `[watchdog] claw ${clawId} ${reasonText}`);
  audit.write(WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_TRIGGERED, `claw=${clawId}`, `reason=${reason}`);

  try {
    // best-effort cleanup before respawn（cleanup 失败不阻塞 respawn、仅 audit）
    await pm.stop(resolveClawDaemonDir(makeClawId(clawId))).catch((e) => {
      const msg = `[watchdog] Failed to clean up claw ${clawId} before restart: ${formatErr(e)}`;
      logWithAudit(fsFactory, msg, WATCHDOG_AUDIT_EVENTS.CLEANUP_FAILED, `message=${audit.message(msg)}`);
    });
    const daemonEntryPath = resolveDaemonEntry();
    const clawDir = path.join(getChestnutDir(), getRelativeClawDir(clawId));
    const pid = await pm.spawn(resolveClawDaemonDir(makeClawId(clawId)), {
      command: 'node',
      args: [daemonEntryPath, clawId],
      // logFile 照 claw daemon CLI 启动惯例（claw-daemon.ts:53）
      logFile: path.join(clawDir, DAEMON_LOG),
      env: { ...process.env, CHESTNUT_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
      cwd: getWorkspaceRoot(),
    });
    log(fsFactory, `[watchdog] claw ${clawId} restarted (PID=${pid})`);
    audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED, `claw=${clawId}`, `pid=${pid}`);
    return { kind: 'spawned', pid };
  } catch (err) {
    if (err instanceof ProcessSpawnConflictError) {
      // 合法 spawn ownership conflict → 另一实例赢了 race、不计失败
      log(fsFactory, `[watchdog] claw ${clawId} already started by another instance`);
      return { kind: 'spawn_conflict', reason: err.reason };
    }
    audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED, `claw=${clawId}`, `error=${formatErr(err)}`);
    log(fsFactory, `[watchdog] FAILED to restart claw ${clawId}: ${err}`);
    return { kind: 'failed', error: err };
  }
}

/**
 * phase 1383 Step D (U4): daemon 心跳文件名（与 src/daemon/constants.ts 同步，
 * Watchdog 不反向 import daemon 内部常量）。
 */
const DAEMON_HEARTBEAT_FILENAME = 'heartbeat';

/**
 * 读 claw 心跳文件并返回「距今年龄（ms）」。
 * - 文件缺失 / 内容非法 / 时间戳无法解析 → 返回 undefined（调用方按「读失败」skip + audit）。
 *   旧版本 daemon 升级后首次心跳前本就无文件，读失败必须 skip，不误重启。
 */
function readHeartbeatAgeMs(clawDir: string, fsFactory: (baseDir: string) => FileSystem): number | undefined {
  const fs = fsFactory(clawDir);
  let raw: string;
  try {
    raw = fs.readSync(DAEMON_HEARTBEAT_FILENAME);
  } catch (err) {
    if (isFileNotFound(err)) return undefined;
    throw err;
  }
  const ts = Date.parse(raw.trim());
  if (!Number.isFinite(ts)) return undefined;
  return Date.now() - ts;
}

/**
 * phase 1383 Step D (U4): 心跳文件过期检测 —— 进程 alive 但事件循环全阻塞时
 * in-process 自活也无法触发，靠心跳时间戳过期判定「功能死」并复用 crash 重启状态机。
 *
 * 边界：
 * - 进程死 → 不由本函数管（maybeCronClawCrash 负责）；本函数只看 alive claw。
 * - 无 active contract → skip（与 crash 同：无契约的 claw 不重启）。
 * - 心跳缺失/非法（存量旧 daemon、刚启动）→ HEARTBEAT_CHECK_FAILED audit + skip，不误重启。
 * - 心跳新鲜 → no-op。
 * - 心跳过期 → 复用 clawRestartStateAPI 同一状态机（daemonAlive 强制 false 推进重启）。
 */
export async function maybeCronClawHeartbeat(pm: ProcessManager, audit: AuditLog, fsFactory: (baseDir: string) => FileSystem): Promise<void> {
  let clawNames: string[];
  try {
    clawNames = enumerateClaws(getChestnutFs(fsFactory), 'claws');
  } catch (err) {
    if (isFileNotFound(err)) return;  // no claws dir = no claws
    audit.write(
      WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED,
      `ctx=heartbeat`,
      `dir=claws`,
      `error=${formatErr(err)}`,
    );
    return;
  }

  const maxRestart = getWatchdogMaxRestart();
  const intervalMs = getWatchdogConfig(fsFactory).interval_ms;

  for (const rawClawId of clawNames) {
    const clawId = rawClawId;
    const clawDir = path.join(getChestnutDir(), getRelativeClawDir(rawClawId));
    const daemonDir = resolveClawDaemonDir(makeClawId(clawId));
    const currentlyAlive = pm.getAliveStatus(daemonDir).alive;

    if (!currentlyAlive) continue;  // 进程死 → crash 检测路径管

    if (!clawHasActiveContract(clawDir, fsFactory, audit)) {
      continue;  // 无 active contract → 不重启（与 crash 判定一致）
    }

    let staleMs: number | undefined;
    try {
      staleMs = readHeartbeatAgeMs(clawDir, fsFactory);
    } catch (err) {
      audit.write(
        WATCHDOG_AUDIT_EVENTS.HEARTBEAT_CHECK_FAILED,
        `claw=${rawClawId}`,
        `error=${formatErr(err)}`,
      );
      continue;
    }

    if (staleMs === undefined) {
      // 文件缺失或非法：存量旧 daemon / 刚启动空窗 → audit + skip（不误重启）
      audit.write(
        WATCHDOG_AUDIT_EVENTS.HEARTBEAT_CHECK_FAILED,
        `claw=${rawClawId}`,
        `reason=missing_or_invalid`,
      );
      continue;
    }

    if (staleMs <= HEARTBEAT_STALE_TIMEOUT_MS) continue;  // 心跳新鲜

    await runClawRestartStateMachine({
      pm, fsFactory, audit,
      clawId: rawClawId, clawDir,
      reason: 'heartbeat_stale',
      daemonAlive: false,  // 功能死：强制按 dead 推进重启状态机
      now: Date.now(), maxRestart, intervalMs,
    });
  }
}

