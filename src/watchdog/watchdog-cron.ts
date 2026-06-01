/**
 * @module L6.Watchdog.Cron
 * Watchdog cron jobs — claw inactivity timeout + crash detection
 */

import * as path from 'path';
import type { FileSystem } from '../foundation/fs/types.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import {
  getChestnutDir, getChestnutFs, getGlobalConfig, getMotionContext,
  lastInactivityNotified, inactivityNotifyCount, clawPreviouslyAlive, everSpawned, clawPreviouslyNotified,
} from './watchdog-context.js';
import { log, writeClawInactivityInbox } from './watchdog-log.js';
import { clawHasActiveContract, getClawActivityInfo, gatherClawSnapshot, getEffectiveInterval, shouldResetNotifyCount, deriveFailureClass, formatInactivityBody, deriveCrashClass, formatCrashBody, hasCleanStopMarker } from './watchdog-utils.js';
import { getContractCreatedMs } from '../core/contract/index.js';
import { getNamedSubrootDir } from '../foundation/config/index.js';
import { notifyClaw } from '../foundation/messaging/index.js';
import { makeChestnutRoot, makeClawDir } from '../foundation/identity/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { MOTION_CLAW_ID } from '../constants.js';
import { makeClawId } from '../foundation/identity/index.js';
import { CLAWS_DIR } from '../foundation/paths.js';



// Check for claws with an active contract but no progress for a long time, and send a reminder
/** 1:1 保 watchdog.ts:271-349 / 78 行 / inactivity timeout + backoff */
export async function maybeCronClawInactivity(pm: ProcessManager, audit: AuditLog, fsFactory: (baseDir: string) => FileSystem): Promise<void> {
  const timeoutMs = getGlobalConfig(fsFactory).watchdog?.claw_inactivity_timeout_ms ?? 300000;
  const fs = getChestnutFs(fsFactory);
  if (!fs.existsSync(CLAWS_DIR)) return;

  // 清理已不存在的 claw 的 Map 条目
  const clawEntries = fs.listSync(CLAWS_DIR, { includeDirs: true }).filter(e => e.isDirectory);
  const existingClawIds = new Set(clawEntries.map(entry => entry.name));
  audit.write(WATCHDOG_AUDIT_EVENTS.CLAW_SCAN, `ctx=inactivity present=${[...existingClawIds].join(',')}`);
  for (const id of lastInactivityNotified.keys()) {
    if (!existingClawIds.has(id)) {
      lastInactivityNotified.delete(id);
      inactivityNotifyCount.delete(id);
    }
  }

  const now = Date.now();
  for (const rawClawId of clawEntries.map(e => e.name)) {
    const clawId = makeClawId(rawClawId);
    try {
      const clawDir = makeClawDir(path.join(getChestnutDir(), CLAWS_DIR, rawClawId));

      // phase 1482: inactivity 仅对 ACTIVE contract 触发 / paused 本就该停（不算 inactivity / D 类 root cause fix）
      if (!clawHasActiveContract(clawDir, fsFactory, audit)) continue;

      // phase 2 γ4: inactivity 仅对 daemon ALIVE 触发 / daemon dead 归 crash_notification 覆盖（0 dedup 重叠）
      if (!pm.isAlive(clawId)) continue;

      // Parse stream.jsonl to get real progress
      const clawFs = fsFactory(clawDir);
      const { lastEventMs, lastError } = await getClawActivityInfo(clawFs, audit);

      // Merge with contract creation time to handle contract recreation scenario
      const contractCreatedMs = getContractCreatedMs(clawFs, clawDir, audit);
      const referenceMs = Math.max(lastEventMs ?? 0, contractCreatedMs ?? 0) || null;
      if (referenceMs === null) continue;

      // Not yet timed out
      if (now - referenceMs < timeoutMs) continue;

      // Reset count if claw has made new progress since last notification
      const lastNotified = lastInactivityNotified.get(rawClawId) ?? 0;
      if (shouldResetNotifyCount(referenceMs, lastNotified)) {
        inactivityNotifyCount.set(rawClawId, 0);
      }

      const notifyCount = inactivityNotifyCount.get(rawClawId) ?? 0;

      // Backoff interval: first 2 notifications use timeoutMs, from the 3rd onward use 3x
      const effectiveInterval = getEffectiveInterval(notifyCount, timeoutMs);
      if (now - lastNotified < effectiveInterval) continue;

      // Collect snapshot info
      const snapshot = gatherClawSnapshot(clawDir, fsFactory, pm, clawId);
      const inactiveMin = Math.round((now - referenceMs) / 60000);

      // phase 1482: 业主 own FailureClass enum + body 按 class 改字面（取代 "no progress" 误导）
      const displayCount = notifyCount + 1;
      const failureClass = deriveFailureClass({
        daemonAlive: snapshot.status === 'running',
        lastError,
      });
      const body = formatInactivityBody({
        clawId,
        inactiveMin,
        notifyCount: displayCount,
        failureClass,
        daemonStatus: snapshot.status,
        contract: snapshot.contract,
        inboxPending: snapshot.inboxPending,
        outboxPending: snapshot.outboxPending,
        lastError,
      });

      log(fsFactory, `[watchdog] Claw ${rawClawId} ${failureClass} ${inactiveMin}m (notify #${displayCount})${lastError ? ` (last error: ${lastError})` : ''}`);
      writeClawInactivityInbox(fsFactory, {
        message: body,
        claw_id: rawClawId,
        inactive_ms: now - referenceMs,
        status: snapshot.status,
        contract: snapshot.contract,
        inbox_pending: snapshot.inboxPending,
        outbox_pending: snapshot.outboxPending,
        notify_count: displayCount,
        as_of: new Date().toISOString(),
        failure_class: failureClass,
        ...(lastError ? { last_error: lastError } : {}),
      });
      inactivityNotifyCount.set(rawClawId, displayCount);
      lastInactivityNotified.set(rawClawId, now);
    } catch (err) {
      log(fsFactory, `[watchdog] Error checking claw ${rawClawId}: ${err instanceof Error ? err.message : String(err)}`);
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
  if (!fs.existsSync(CLAWS_DIR)) return;

  // 清理已不存在的 claw 的 Map 条目
  const clawEntries = fs.listSync(CLAWS_DIR, { includeDirs: true }).filter(e => e.isDirectory);
  const existingClawIds = new Set(clawEntries.map(entry => entry.name));
  audit.write(WATCHDOG_AUDIT_EVENTS.CLAW_SCAN, `ctx=crash present=${[...existingClawIds].join(',')}`);
  for (const id of clawPreviouslyAlive.keys()) {
    if (!existingClawIds.has(id)) {
      clawPreviouslyAlive.delete(id);
      everSpawned.delete(id);
      clawPreviouslyNotified.delete(id);
    }
  }

  for (const rawClawId of clawEntries.map(e => e.name)) {
    const clawId = makeClawId(rawClawId);
    const clawDir = makeClawDir(path.join(getChestnutDir(), CLAWS_DIR, rawClawId));
    const currentlyAlive = pm.isAlive(clawId);

    if (currentlyAlive) {
      everSpawned.add(rawClawId);
    }

    if (!currentlyAlive) {
      // phase 2 γ4: 触发条件 = dead + activeContract + !notified（不再要求 transition / 覆盖 S7）
      // paused contract 永不通知 (clawHasActiveContract 内部已 active-only)
      if (!clawHasActiveContract(clawDir, fsFactory, audit)) {
        // 不发通知（contract 不 active 或不存在）
        clawPreviouslyAlive.set(rawClawId, currentlyAlive);
        continue;
      }

      if (clawPreviouslyNotified.has(rawClawId)) {
        audit.write(
          WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_DEDUPED,
          `claw=${rawClawId}`,
          `reason=already_notified`,
        );
        clawPreviouslyAlive.set(rawClawId, currentlyAlive);
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

      const snapshot = gatherClawSnapshot(clawDir, fsFactory, pm, clawId);
      const body = formatCrashBody({
        clawId: rawClawId,
        crashClass,
        contract: snapshot.contract,
        outboxPending: snapshot.outboxPending,
        lastAuditEvents: snapshot.lastAuditEvents,
      });

      const { fs: motionFs, audit: motionAudit } = getMotionContext(fsFactory);
      const chestnutRoot = makeChestnutRoot(path.dirname(makeClawDir(getNamedSubrootDir('motion'))));
      notifyClaw(motionFs, chestnutRoot, MOTION_CLAW_ID, {
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

      clawPreviouslyNotified.set(rawClawId, Date.now());
    }

    // Alive recovery transition: allow next crash to re-notify (option a — simple 1 notif per event)
    if (currentlyAlive && clawPreviouslyNotified.has(clawId)) {
      clawPreviouslyNotified.delete(clawId);
      audit.write(
        WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_RESET,
        `claw=${clawId}`,
        `reason=recovered_alive`,
      );
    }

    clawPreviouslyAlive.set(clawId, currentlyAlive);
  }
}
