/**
 * @module L6.Watchdog.Cron
 * Watchdog cron jobs — claw inactivity timeout + crash detection
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
import { log, logWithAudit, writeClawInactivityInbox } from './watchdog-log.js';
import type { FailureClass } from './claw-failure-classes.js';
import { clawHasActiveContract, getClawActivityInfo, gatherClawSnapshot, shouldResetNotifyCount, deriveFailureClass, formatInactivityBody, deriveCrashClass, hasCleanStopMarker, WATCHDOG_BACKOFF_MAX_MS, getWatchdogMaxRestart } from './watchdog-utils.js';
import { listSubscriptions, consumeSubscription } from './subscription-store.js';
import { getActiveContractTimestamp } from '../core/contract/index.js';
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

interface FireInactivityOpts {
  rawClawId: string;
  clawId: string;
  clawDir: string;
  fsFactory: (baseDir: string) => FileSystem;
  pm: ProcessManager;
  inactiveMin: number;
  inactiveMs: number;
  lastError: string | null;
  /** 仅 subscription 触发路径传入 typed literal；普通 timeout 缺失。 */
  sourcePath?: 'subscription';
  audit?: AuditLog;
}

function fireInactivityNotification(opts: FireInactivityOpts): { failureClass: FailureClass } {
  const { rawClawId, clawId, clawDir, fsFactory, pm, inactiveMin, inactiveMs, lastError, sourcePath, audit } = opts;
  const snapshot = gatherClawSnapshot(clawDir, fsFactory, pm, clawId, audit);
  const failureClass = deriveFailureClass({
    daemonAlive: snapshot.status === 'running',
    lastError,
  });
  const body = formatInactivityBody({
    clawId,
    inactiveMin,
    failureClass,
    contract: snapshot.contract,
    lastError,
  });

  // phase 1258 Step A: 不再声明 wire key — 传 typed facts 给 writer，
  // extraFields 只经 owner codec (claw-inactivity-guidance.ts) 产出（v1 wire）。
  // asOf 此处单次生成、writer 内不再取时间（body/audit/wire 观察点不漂移）。
  writeClawInactivityInbox(fsFactory, {
    body,
    guidance: {
      clawId: rawClawId,
      failureClass,
      inactiveMs,
      contract: snapshot.contract,
      asOf: new Date().toISOString(),
      ...(sourcePath ? { sourcePath } : {}),
      ...(lastError ? { lastError } : {}),
    },
  });

  return { failureClass };
}

// Check for claws with an active contract but no progress for a long time, and send a reminder
/** 1:1 保 watchdog.ts:271-349 / 78 行 / inactivity timeout + backoff */
export async function maybeCronClawInactivity(pm: ProcessManager, audit: AuditLog, fsFactory: (baseDir: string) => FileSystem): Promise<void> {
  const timeoutMs = getWatchdogConfig(fsFactory).claw_inactivity_timeout_ms;
  const fs = getChestnutFs(fsFactory);
  // 枚举 claws 并清理已不存在的 claw 的 Map 条目
  let clawNames: string[];
  try {
    clawNames = enumerateClaws(fs, 'claws');
  } catch (err) {
    if (isFileNotFound(err)) {
      // phase 138: claws dir 不存在 = no claws present、cleanup 全部 stale entries（audit.P1.wd-1 真治）
      const emptyExisting = new Set<string>();
      pruneStaleMapEntries(clawStateAPI.lastInactivityNotified, emptyExisting);
      pruneStaleMapEntries(clawStateAPI.inactivityNotifyCount, emptyExisting);
      return;
    }
    // phase 697: 加 dir col、与 phase 696 SUBSCRIPTION_DIR_LIST_FAILED + ARCHIVE_DIR_FAILED 对齐
    audit.write(
      WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED,
      `ctx=inactivity`,
      `dir=claws`,
      `error=${formatErr(err)}`,
    );
    return;  // 其他错 = treat as no claws、下 tick 重试
  }
  const existingClawIds = new Set(clawNames);
  // phase 691: 拆 ctx + present 为两独立 col、与 phase 690 WATCHDOG_CHECK 同模式修正
  audit.write(
    WATCHDOG_AUDIT_EVENTS.CLAW_SCAN,
    `ctx=inactivity`,
    `present=${[...existingClawIds].join(',')}`,
  );
  pruneStaleMapEntries(clawStateAPI.lastInactivityNotified, existingClawIds);
  pruneStaleMapEntries(clawStateAPI.inactivityNotifyCount, existingClawIds);

  const now = Date.now();
  for (const rawClawId of clawNames) {
    const clawId = rawClawId;
    try {
      const clawDir = path.join(getChestnutDir(), getRelativeClawDir(rawClawId));

      // phase 1482: inactivity 仅对 ACTIVE contract 触发 / legacy paused 不参与当前 lifecycle（不算 inactivity / D 类 root cause fix）
      if (!clawHasActiveContract(clawDir, fsFactory, audit)) continue;

      // phase 2 γ4: inactivity 仅对 daemon ALIVE 触发 / daemon dead 归 claw_crashed 覆盖（0 dedup 重叠）
      if (!pm.isAlive(resolveClawDaemonDir(makeClawId(clawId)))) continue;

      // Parse stream.jsonl to get real progress
      const clawFs = fsFactory(clawDir);
      const { lastEventMs, lastError } = await getClawActivityInfo(clawFs, audit);

      // Merge with contract creation time to handle contract recreation scenario
      const contractCreatedMs = getActiveContractTimestamp(clawFs, clawDir);
      const referenceMs = Math.max(lastEventMs ?? 0, contractCreatedMs ?? 0) || null;
      if (referenceMs === null) continue;

      // Not yet timed out
      if (now - referenceMs < timeoutMs) continue;

      // phase 4 续: 1-shot per stuck period (取代 phase 1482 multi-notif backoff)
      //   - 已通知过 + claw 无新 stream 活动 → skip (user 关切「占用 motion 上下文」)
      //   - shouldResetNotifyCount (referenceMs > lastNotified) = 真有 progress → 允许重新通知
      //   - motion 干预后 claw 完全冻死无 stream → 无 reset → 走 restart 路径 (claw_crashed) 让 motion 知
      const lastNotified = clawStateAPI.lastInactivityNotified.get(rawClawId) ?? 0;
      if (lastNotified > 0 && !shouldResetNotifyCount(referenceMs, lastNotified)) {
        continue;  // 已通知 + 无 progress → 不重发
      }

      const inactiveMin = Math.round((now - referenceMs) / 60000);
      const { failureClass } = fireInactivityNotification({
        rawClawId,
        clawId,
        clawDir,
        fsFactory,
        pm,
        inactiveMin,
        inactiveMs: now - referenceMs,
        lastError,
        audit,
      });
      log(fsFactory, `[watchdog] Claw ${rawClawId} ${failureClass} ${inactiveMin}m${lastError ? ` (last error: ${lastError})` : ''}`);
      clawStateAPI.lastInactivityNotified.set(rawClawId, now);
    } catch (err) {
      audit.write(
        WATCHDOG_AUDIT_EVENTS.CLAW_INACTIVITY_CHECK_FAILED,
        `claw=${rawClawId}`,
        `error=${formatErr(err)}`,
      );
      log(fsFactory, `[watchdog] Error checking claw ${rawClawId}: ${formatErr(err)}`);  // 保留 dev-debug
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
    const currentlyAlive = pm.isAlive(resolveClawDaemonDir(makeClawId(clawId)));

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

// phase 5: motion-requested inactivity subscriptions tick handler.
// 每 tick 扫 watchdog-subscriptions/ dir、判定 fire-or-consume 各订阅 (一次性).
//
// Conditions per subscription (claw_id, subscribed_at, threshold_ms):
//   (a) claw dir 消失 OR 无 active contract → consume silent (CONSUMED_NO_CONTRACT audit)
//   (b) claw 自 subscribed_at 以来有 stream event → consume silent / claw 已恢复 (CONSUMED_RECOVERED audit)
//   (c) now < subscribed_at + threshold_ms → 等下次 tick
//   (d) now >= subscribed_at + threshold_ms + 仍 stuck → fire claw_inactivity (与 1-shot path 同 type / 同 body shape) + consume
export async function maybeCronCheckSubscriptions(pm: ProcessManager, audit: AuditLog, fsFactory: (baseDir: string) => FileSystem): Promise<void> {
  const fs = getChestnutFs(fsFactory);
  const subs = listSubscriptions(fs, audit);
  if (subs.length === 0) return;

  const now = Date.now();
  for (const sub of subs) {
    const rawClawId = sub.clawId;
    const clawId = rawClawId;
    const clawDir = path.join(getChestnutDir(), getRelativeClawDir(rawClawId));

    try {
      // (a) claw missing or no active contract → consume
      if (!clawHasActiveContract(clawDir, fsFactory, audit)) {
        audit.write(
          WATCHDOG_AUDIT_EVENTS.SUBSCRIPTION_CONSUMED_NO_CONTRACT,
          `claw=${rawClawId}`,
          `reason=no_active_contract`,
        );
        consumeSubscription(fs, rawClawId);
        continue;
      }

      // (b) claw recovered (stream advanced past subscription time) → consume silent
      const clawFs = fsFactory(clawDir);
      const { lastEventMs, lastError } = await getClawActivityInfo(clawFs, audit);
      if (lastEventMs !== null && lastEventMs > sub.subscribed_at) {
        audit.write(
          WATCHDOG_AUDIT_EVENTS.SUBSCRIPTION_CONSUMED_RECOVERED,
          `claw=${rawClawId}`,
          `last_event_ms=${lastEventMs}`,
        );
        consumeSubscription(fs, rawClawId);
        continue;
      }

      // (c) threshold not yet reached → wait
      const fireAt = sub.subscribed_at + sub.threshold_ms;
      if (now < fireAt) continue;

      // (d) still stuck after threshold → fire + consume
      const inactiveMs = lastEventMs !== null ? (now - lastEventMs) : (now - sub.subscribed_at);
      const inactiveMin = Math.round(inactiveMs / 60000);
      const { failureClass } = fireInactivityNotification({
        rawClawId,
        clawId,
        clawDir,
        fsFactory,
        pm,
        inactiveMin,
        inactiveMs,
        lastError,
        sourcePath: 'subscription',
        audit,
      });
      log(fsFactory, `[watchdog] Claw ${rawClawId} subscription fired ${failureClass} ${inactiveMin}m${lastError ? ` (last error: ${lastError})` : ''}`);
      audit.write(
        WATCHDOG_AUDIT_EVENTS.SUBSCRIPTION_FIRED,
        `claw=${rawClawId}`,
        `threshold_ms=${sub.threshold_ms}`,
        `failure_class=${failureClass}`,
      );
      // 同 1-shot path: 更新 lastInactivityNotified 防止 maybeCronClawInactivity 立即重发
      clawStateAPI.lastInactivityNotified.set(rawClawId, now);
      consumeSubscription(fs, rawClawId);
    } catch (err) {
      audit.write(
        WATCHDOG_AUDIT_EVENTS.SUBSCRIPTION_PROCESS_FAILED,
        `claw=${rawClawId}`,
        `error=${formatErr(err)}`,
      );
      log(fsFactory, `[watchdog] Error processing subscription for ${rawClawId}: ${formatErr(err)}`);
      // 不 consume / 下次 tick 重试
    }
  }
}
