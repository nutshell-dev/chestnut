/**
 * @module L6.Watchdog.Cron
 * Watchdog cron jobs — claw inactivity timeout + crash detection
 */

import * as path from 'path';
import type { FileSystem } from '../foundation/fs/types.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import {
  getClawforumDir, getClawforumFs, getGlobalConfig, getMotionContext,
  lastInactivityNotified, inactivityNotifyCount, clawPreviouslyAlive, everSpawned, clawPreviouslyNotified,
} from './watchdog-context.js';
import { log, writeWatchdogInboxMessage } from './watchdog-log.js';
import { clawHasContract, getClawActivityInfo, gatherClawSnapshot, getEffectiveInterval, shouldResetNotifyCount } from './watchdog-utils.js';
import { getContractCreatedMs } from '../core/contract/index.js';
import { getNamedSubrootDir } from '../foundation/config/index.js';
import { notifyClaw } from '../foundation/messaging/index.js';
import { makeClawforumRoot, makeClawDir } from '../foundation/identity/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { MOTION_CLAW_ID } from '../constants.js';
import { makeClawId } from '../foundation/identity/index.js';
import { CLAWS_DIR } from '../foundation/paths.js';



// Check for claws with an active contract but no progress for a long time, and send a reminder
/** 1:1 保 watchdog.ts:271-349 / 78 行 / inactivity timeout + backoff */
export async function maybeCronClawInactivity(pm: ProcessManager, audit: AuditLog, fsFactory: (baseDir: string) => FileSystem): Promise<void> {
  const timeoutMs = getGlobalConfig(fsFactory).watchdog?.claw_inactivity_timeout_ms ?? 300000;
  const fs = getClawforumFs(fsFactory);
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
      const clawDir = makeClawDir(path.join(getClawforumDir(), CLAWS_DIR, rawClawId));

      // Has an active contract?
      if (!clawHasContract(clawDir, fsFactory, audit)) continue;

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

      // Body without directives: pure factual data (including notification number)
      const displayCount = notifyCount + 1;
      let body = `Claw ${clawId} no progress for ${inactiveMin}m (notification #${displayCount}). Status: ${snapshot.status}, contract: ${snapshot.contract}, inbox_pending: ${snapshot.inboxPending}, outbox_pending: ${snapshot.outboxPending}`;
      if (lastError) body += `, last error: ${lastError}`;

      log(fsFactory, `[watchdog] Claw ${rawClawId} no progress ${inactiveMin}m (notify #${displayCount}) with active contract${lastError ? ` (last error: ${lastError})` : ''}`);
      writeWatchdogInboxMessage(fsFactory, 'claw_inactivity', {
        message: body,
        claw_id: rawClawId,
        inactive_ms: now - referenceMs,
        status: snapshot.status,
        contract: snapshot.contract,
        inbox_pending: snapshot.inboxPending,
        outbox_pending: snapshot.outboxPending,
        notify_count: displayCount,
        as_of: new Date().toISOString(),
        ...(lastError ? { last_error: lastError } : {}),
      });
      inactivityNotifyCount.set(rawClawId, displayCount);
      lastInactivityNotified.set(rawClawId, now);
    } catch (err) {
      log(fsFactory, `[watchdog] Error checking claw ${rawClawId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Detect claw process crashes and notify motion
/** 1:1 保 watchdog.ts:350-401 / 51 行 / crash 检测 */
export function maybeCronClawCrash(pm: ProcessManager, audit: AuditLog, fsFactory: (baseDir: string) => FileSystem): void {
  const fs = getClawforumFs(fsFactory);
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
    const clawDir = makeClawDir(path.join(getClawforumDir(), CLAWS_DIR, rawClawId));
    const currentlyAlive = pm.isAlive(clawId);
    const wasAlive = clawPreviouslyAlive.get(rawClawId);

    if (currentlyAlive) {
      everSpawned.add(rawClawId);
    }

    if ((wasAlive === true || everSpawned.has(rawClawId)) && !currentlyAlive) {
      const detectMethod = wasAlive === true ? 'previous_tick' : 'ever_spawned';

      // Dedup: skip re-emitting crash_notification for already-notified claw
      if (clawPreviouslyNotified.has(rawClawId)) {
        audit.write(
          WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_DEDUPED,
          `claw=${rawClawId}`,
          `reason=already_notified`,
        );
        clawPreviouslyAlive.set(rawClawId, currentlyAlive);
        continue;
      }

      // Only notify motion when there is an active/paused contract (no notification needed if claw stops without a contract)
      if (!clawHasContract(clawDir, fsFactory, audit)) {
        log(fsFactory, `[watchdog] Claw ${rawClawId} stopped (no active contract, skipping notification) [${detectMethod}]`);
        audit.write(WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED, `claw=${rawClawId}`, 'has_contract=false', `detected_by=${detectMethod}`);
        clawPreviouslyAlive.set(rawClawId, currentlyAlive);
        continue;
      }
      log(fsFactory, `[watchdog] Claw ${rawClawId} crashed (${detectMethod}, was alive, now stopped)`);
      audit.write(WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED, `claw=${rawClawId}`, 'has_contract=true', `detected_by=${detectMethod}`);

      // Collect snapshot info
      const snapshot = gatherClawSnapshot(clawDir, fsFactory, pm, clawId);
      const lastEventsStr = snapshot.lastAuditEvents?.length
        ? `; last_events: ${snapshot.lastAuditEvents.map(e => e.replace(/\t/g, '|')).join(' >> ')}`
        : '';
      const body = `contract: ${snapshot.contract}, outbox_pending: ${snapshot.outboxPending}${lastEventsStr}`;

      const { fs: motionFs, audit: motionAudit } = getMotionContext(fsFactory);
      const clawforumRoot = makeClawforumRoot(path.dirname(makeClawDir(getNamedSubrootDir('motion'))));
      notifyClaw(motionFs, clawforumRoot, MOTION_CLAW_ID, {
        type: 'crash_notification',
        source: rawClawId,
        priority: 'high',
        body,
      }, motionAudit);

      clawPreviouslyNotified.set(rawClawId, Date.now());
    }

    // Alive recovery transition: allow next crash to re-notify
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
