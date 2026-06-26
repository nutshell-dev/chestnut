/**
 * @module L6.Watchdog.Cron
 * Watchdog cron jobs — claw inactivity timeout + crash detection
 */

import { makeChestnutRoot } from '../core/claw-topology/claw-instance-paths.js';
import * as path from 'path';
import { formatErr } from "../foundation/node-utils/index.js";
import type { FileSystem } from '../foundation/fs/index.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import {
  getChestnutDir, getChestnutFs, getGlobalConfig, getMotionContext,
  clawStateAPI,
} from './watchdog-context.js';
import { log, writeClawInactivityInbox } from './watchdog-log.js';
import { clawHasActiveContract, getClawActivityInfo, gatherClawSnapshot, shouldResetNotifyCount, deriveFailureClass, formatInactivityBody, deriveCrashClass, formatCrashBody, hasCleanStopMarker } from './watchdog-utils.js';
import { listSubscriptions, consumeSubscription } from './subscription-store.js';
import { getActiveContractTimestamp } from '../core/contract/index.js';
import { getNamedSubrootDir } from '../core/claw-topology/claw-instance-paths.js';
import { routeNotifyClaw } from '../core/claw-topology/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../core/claw-topology/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import { CLAWS_DIR } from '../core/claw-topology/claw-instance-paths.js';

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
  sourcePath?: string;
  audit?: AuditLog;
}

function fireInactivityNotification(opts: FireInactivityOpts): { failureClass: string } {
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

  writeClawInactivityInbox(fsFactory, {
    message: body,
    claw_id: rawClawId,
    inactive_ms: inactiveMs,
    contract: snapshot.contract,
    as_of: new Date().toISOString(),
    failure_class: failureClass,
    ...(sourcePath ? { source_path: sourcePath } : {}),
    ...(lastError ? { last_error: lastError } : {}),
  });

  return { failureClass };
}

// Check for claws with an active contract but no progress for a long time, and send a reminder
/** 1:1 保 watchdog.ts:271-349 / 78 行 / inactivity timeout + backoff */
export async function maybeCronClawInactivity(pm: ProcessManager, audit: AuditLog, fsFactory: (baseDir: string) => FileSystem): Promise<void> {
  const timeoutMs = getGlobalConfig(fsFactory).watchdog.claw_inactivity_timeout_ms;
  const fs = getChestnutFs(fsFactory);
  if (!fs.existsSync(CLAWS_DIR)) {
    // phase 138: existsSync false = no claws present、cleanup 全部 stale entries（audit.P1.wd-1 真治）
    const emptyExisting = new Set<string>();
    pruneStaleMapEntries(clawStateAPI.lastInactivityNotified, emptyExisting);
    pruneStaleMapEntries(clawStateAPI.inactivityNotifyCount, emptyExisting);
    return;
  }

  // 清理已不存在的 claw 的 Map 条目
  let clawEntries: ReturnType<typeof fs.listSync>;
  try {
    clawEntries = fs.listSync(CLAWS_DIR, { includeDirs: true }).filter(e => e.isDirectory);
  } catch (err) {
    if (!isFileNotFound(err)) {
      // phase 697: 加 dir col、与 phase 696 SUBSCRIPTION_DIR_LIST_FAILED + ARCHIVE_DIR_FAILED 对齐
      audit.write(
        WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED,
        `ctx=inactivity`,
        `dir=${CLAWS_DIR}`,
        `error=${formatErr(err)}`,
      );
    }
    return;  // race / 其他错 = treat as no claws、下 tick 重试
  }
  const existingClawIds = new Set(clawEntries.map(entry => entry.name));
  // phase 691: 拆 ctx + present 为两独立 col、与 phase 690 WATCHDOG_CHECK 同模式修正
  audit.write(
    WATCHDOG_AUDIT_EVENTS.CLAW_SCAN,
    `ctx=inactivity`,
    `present=${[...existingClawIds].join(',')}`,
  );
  pruneStaleMapEntries(clawStateAPI.lastInactivityNotified, existingClawIds);
  pruneStaleMapEntries(clawStateAPI.inactivityNotifyCount, existingClawIds);

  const now = Date.now();
  for (const rawClawId of clawEntries.map(e => e.name)) {
    const clawId = rawClawId;
    try {
      const clawDir = path.join(getChestnutDir(), CLAWS_DIR, rawClawId);

      // phase 1482: inactivity 仅对 ACTIVE contract 触发 / paused 本就该停（不算 inactivity / D 类 root cause fix）
      if (!clawHasActiveContract(clawDir, fsFactory, audit)) continue;

      // phase 2 γ4: inactivity 仅对 daemon ALIVE 触发 / daemon dead 归 crash_notification 覆盖（0 dedup 重叠）
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
      //   - motion 干预后 claw 完全冻死无 stream → 无 reset → 走 restart 路径 (crash_notification) 让 motion 知
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

// Detect claw process crashes (dead daemon with active contract) and notify motion.
// phase 2 γ4 reframe:
//   - Trigger 条件改：dead + activeContract + !notified（原 `(wasAlive‖everSpawned)` requirement 移除 / 覆盖 S7 从未 spawn）
//   - paused contract 永不通知（与 phase 1482 inactivity-paused-skip 一致 / DP「不打扰」）
//   - 业主 own CrashClass enum (active_unexpected / active_user_stopped) by clean-stop marker
//   - extraFields 透传 crash_class + 上下文 to motion guidance composer
export function maybeCronClawCrash(pm: ProcessManager, audit: AuditLog, fsFactory: (baseDir: string) => FileSystem): void {
  const fs = getChestnutFs(fsFactory);
  if (!fs.existsSync(CLAWS_DIR)) {
    // phase 138: existsSync false = no claws present、cleanup 全部 stale entries（audit.P1.wd-1 真治）
    const emptyExisting = new Set<string>();
    pruneStaleMapEntries(clawStateAPI.clawPreviouslyAlive, emptyExisting);
    pruneStaleMapEntries(clawStateAPI.everSpawned, emptyExisting);
    pruneStaleMapEntries(clawStateAPI.clawPreviouslyNotified, emptyExisting);
    return;
  }

  // 清理已不存在的 claw 的 Map 条目
  let clawEntries: ReturnType<typeof fs.listSync>;
  try {
    clawEntries = fs.listSync(CLAWS_DIR, { includeDirs: true }).filter(e => e.isDirectory);
  } catch (err) {
    if (!isFileNotFound(err)) {
      // phase 697: 加 dir col、与 phase 696 SUBSCRIPTION_DIR_LIST_FAILED + ARCHIVE_DIR_FAILED 对齐
      audit.write(
        WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED,
        `ctx=crash`,
        `dir=${CLAWS_DIR}`,
        `error=${formatErr(err)}`,
      );
    }
    return;  // race / 其他错 = treat as no claws、下 tick 重试
  }
  const existingClawIds = new Set(clawEntries.map(entry => entry.name));
  // phase 691: 拆 ctx + present 为两独立 col、与 phase 690 WATCHDOG_CHECK 同模式修正
  audit.write(
    WATCHDOG_AUDIT_EVENTS.CLAW_SCAN,
    `ctx=crash`,
    `present=${[...existingClawIds].join(',')}`,
  );
  pruneStaleMapEntries(clawStateAPI.clawPreviouslyAlive, existingClawIds);
  pruneStaleMapEntries(clawStateAPI.everSpawned, existingClawIds);
  pruneStaleMapEntries(clawStateAPI.clawPreviouslyNotified, existingClawIds);

  for (const rawClawId of clawEntries.map(e => e.name)) {
    const clawId = rawClawId;
    const clawDir = path.join(getChestnutDir(), CLAWS_DIR, rawClawId);
    const currentlyAlive = pm.isAlive(resolveClawDaemonDir(makeClawId(clawId)));

    if (currentlyAlive) {
      clawStateAPI.everSpawned.add(rawClawId);
    }

    if (!currentlyAlive) {
      // phase 2 γ4: 触发条件 = dead + activeContract + !notified（不再要求 transition / 覆盖 S7）
      // paused contract 永不通知 (clawHasActiveContract 内部已 active-only)
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

      if (clawStateAPI.clawPreviouslyNotified.has(rawClawId)) {
        audit.write(
          WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_DEDUPED,
          `claw=${rawClawId}`,
          `reason=already_notified`,
        );
        clawStateAPI.clawPreviouslyAlive.set(rawClawId, currentlyAlive);
        continue;
      }

      // phase 2 γ4: 业主 own CrashClass + clean-stop marker 探测
      const cleanStop = hasCleanStopMarker(clawDir, fsFactory);
      const crashClass = deriveCrashClass({ hasCleanStopMarker: cleanStop });

      audit.write(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED,
        `claw=${rawClawId}`,
        `has_contract=true`,
        `crash_class=${crashClass}`,
      );
      log(fsFactory, `[watchdog] Claw ${rawClawId} ${crashClass}${cleanStop ? ' (clean-stop marker present)' : ' (no marker)'}`);

      const snapshot = gatherClawSnapshot(clawDir, fsFactory, pm, clawId, audit);
      const body = formatCrashBody({
        clawId: rawClawId,
        crashClass,
        contract: snapshot.contract,
      });

      const { fs: motionFs, audit: motionAudit } = getMotionContext(fsFactory);
      const chestnutRoot = makeChestnutRoot(path.dirname(getNamedSubrootDir('motion')));
      routeNotifyClaw(motionFs, chestnutRoot, MOTION_CLAW_ID, MOTION_CLAW_ID, {
        type: 'crash_notification',
        source: rawClawId,
        priority: 'high',
        body,
        extraFields: {
          crash_class: crashClass,
          clean_stop_marker: String(cleanStop),
          contract: snapshot.contract,
          outbox_pending: String(snapshot.outboxPending),
          as_of: new Date().toISOString(),
        },
      }, motionAudit);

      clawStateAPI.clawPreviouslyNotified.set(rawClawId, Date.now());
    }

    // Alive recovery transition: allow next crash to re-notify (option a — simple 1 notif per event)
    if (currentlyAlive && clawStateAPI.clawPreviouslyNotified.has(clawId)) {
      clawStateAPI.clawPreviouslyNotified.delete(clawId);
      audit.write(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_RESET,
        `claw=${clawId}`,
        `reason=recovered_alive`,
      );
    }

    clawStateAPI.clawPreviouslyAlive.set(clawId, currentlyAlive);
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
    const clawDir = path.join(getChestnutDir(), CLAWS_DIR, rawClawId);

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
