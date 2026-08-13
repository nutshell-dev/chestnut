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
      const prior = clawRestartStateAPI.get(rawClawId) ?? { status: 'closed', consecutiveAttempts: 0 };
      const decision = decideDaemonRestart(prior, false, now, maxRestart);
      // 状态推进与 motion 主 loop 同构：decision.state 统一落盘（attempt 分支随后以 reduce 结果覆盖）
      clawRestartStateAPI.set(rawClawId, decision.state);

      switch (decision.action) {
        case 'attempt': {
          // crash_class 死因审计（DP1）：clean-stop marker 探测照旧
          const cleanStop = hasCleanStopMarker(clawDir, fsFactory);
          const crashClass = deriveCrashClass({ hasCleanStopMarker: cleanStop });

          audit.write(
            WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
            `claw=${rawClawId}`,
            `has_contract=true`,
            `crash_class=${crashClass}`,
          );
          log(fsFactory, `[watchdog] Claw ${rawClawId} ${crashClass}${cleanStop ? ' (clean-stop marker present)' : ' (no marker)'}`);

          const outcome = await attemptClawRestart(pm, fsFactory, audit, rawClawId);
          // 状态推进与 motion 主 loop 同构（phase 324 H3 锚）：
          //   spawned → retrying(attempts+1, nextAttemptAt=now+min(2^n * interval, BACKOFF_MAX))
          //   spawn_conflict → closed（另一实例赢了 race、不计失败）
          //   failed → retrying(attempts+1)；attempts >= max → 状态机下次返回 circuit_open
          const next = reduceMotionRestartOutcome(
            prior, outcome, Date.now(), intervalMs, WATCHDOG_BACKOFF_MAX_MS,
          );
          clawRestartStateAPI.set(rawClawId, next);
          break;
        }
        case 'defer': break;            // 退避窗口内、本 tick 不尝试
        case 'circuit_open': {
          if (decision.justOpened) {
            audit.write(
              WATCHDOG_AUDIT_EVENTS.CLAW_RESTART_CIRCUIT_OPENED,
              `claw=${rawClawId}`,
              `attempts=${decision.state.consecutiveAttempts}`,
              `cap=${maxRestart}`,
            );
            log(
              fsFactory,
              `[watchdog] gave up restarting claw ${rawClawId} after ${decision.state.consecutiveAttempts} consecutive failures (cap=${maxRestart}); entering circuit-open.`,
            );
          }
          break;                        // 已放弃、不再每 tick 尝试；契约收尾不归本模块（P2）
        }
        case 'healthy': break;          // 不可达（alive 检测已过滤）
      }
    }

    clawStateAPI.clawPreviouslyAlive.set(clawId, currentlyAlive);
  }
}

// === Claw restart helper（phase 1380、镜像 attemptMotionRestart / watchdog.ts） ===

async function attemptClawRestart(
  pm: ProcessManager,
  fsFactory: (baseDir: string) => FileSystem,
  audit: AuditLog,
  clawId: string,
): Promise<MotionSpawnOutcome> {
  log(fsFactory, `[watchdog] claw ${clawId} down, restarting...`);
  audit.write(WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_TRIGGERED, `claw=${clawId}`, `reason=crash_detected`);

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

