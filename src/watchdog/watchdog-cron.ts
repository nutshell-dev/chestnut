/**
 * @module L6.Watchdog.Cron
 * Watchdog cron jobs — claw inactivity timeout + crash detection
 */

import * as path from 'path';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import {
  getClawforumDir, getClawforumFs, getGlobalConfig, getMotionContext,
  lastInactivityNotified, inactivityNotifyCount, clawPreviouslyAlive, everSpawned, clawPreviouslyNotified,
} from './watchdog-context.js';
import { log, writeWatchdogInboxMessage } from './watchdog-log.js';
import { clawHasContract, getClawActivityInfo, gatherClawSnapshot, getEffectiveInterval, shouldResetNotifyCount } from './watchdog-utils.js';
import { getContractCreatedMs } from '../core/contract/index.js';
import { NodeFileSystem } from '../foundation/fs/node-fs.js';
import { getNamedSubrootDir } from '../foundation/config/index.js';
import { InboxWriter } from '../foundation/messaging/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { CLAWS_DIR } from '../foundation/paths.js';

// Check for claws with an active contract but no progress for a long time, and send a reminder
/** 1:1 保 watchdog.ts:271-349 / 78 行 / inactivity timeout + backoff */
export async function maybeCronClawInactivity(pm: ProcessManager, audit: AuditLog): Promise<void> {
  const timeoutMs = getGlobalConfig().watchdog?.claw_inactivity_timeout_ms ?? 300000;
  const fs = getClawforumFs();
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
  for (const clawId of clawEntries.map(e => e.name)) {
    try {
      const clawDir = path.join(getClawforumDir(), CLAWS_DIR, clawId);

      // Has an active contract?
      if (!clawHasContract(clawDir, audit)) continue;

      // Parse stream.jsonl to get real progress
      const clawFs = new NodeFileSystem({ baseDir: clawDir });
      const { lastEventMs, lastError } = await getClawActivityInfo(clawFs, audit);

      // Merge with contract creation time to handle contract recreation scenario
      const contractCreatedMs = getContractCreatedMs(clawFs, clawDir, audit);
      const referenceMs = Math.max(lastEventMs ?? 0, contractCreatedMs ?? 0) || null;
      if (referenceMs === null) continue;

      // Not yet timed out
      if (now - referenceMs < timeoutMs) continue;

      // Reset count if claw has made new progress since last notification
      const lastNotified = lastInactivityNotified.get(clawId) ?? 0;
      if (shouldResetNotifyCount(referenceMs, lastNotified)) {
        inactivityNotifyCount.set(clawId, 0);
      }

      const notifyCount = inactivityNotifyCount.get(clawId) ?? 0;

      // Backoff interval: first 2 notifications use timeoutMs, from the 3rd onward use 3x
      const effectiveInterval = getEffectiveInterval(notifyCount, timeoutMs);
      if (now - lastNotified < effectiveInterval) continue;

      // Collect snapshot info
      const snapshot = gatherClawSnapshot(clawDir, pm, clawId);
      const inactiveMin = Math.round((now - referenceMs) / 60000);

      // Body without directives: pure factual data (including notification number)
      const displayCount = notifyCount + 1;
      let body = `Claw ${clawId} no progress for ${inactiveMin}m (notification #${displayCount}). Status: ${snapshot.status}, contract: ${snapshot.contract}, inbox_pending: ${snapshot.inboxPending}, outbox_pending: ${snapshot.outboxPending}`;
      if (lastError) body += `, last error: ${lastError}`;

      log(`[watchdog] Claw ${clawId} no progress ${inactiveMin}m (notify #${displayCount}) with active contract${lastError ? ` (last error: ${lastError})` : ''}`);
      writeWatchdogInboxMessage('claw_inactivity', {
        message: body,
        claw_id: clawId,
        inactive_ms: now - referenceMs,
        status: snapshot.status,
        contract: snapshot.contract,
        inbox_pending: snapshot.inboxPending,
        outbox_pending: snapshot.outboxPending,
        notify_count: displayCount,
        as_of: new Date().toISOString(),
        ...(lastError ? { last_error: lastError } : {}),
      });
      inactivityNotifyCount.set(clawId, displayCount);
      lastInactivityNotified.set(clawId, now);
    } catch (err) {
      log(`[watchdog] Error checking claw ${clawId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Detect claw process crashes and notify motion
/** 1:1 保 watchdog.ts:350-401 / 51 行 / crash 检测 */
export function maybeCronClawCrash(pm: ProcessManager, audit: AuditLog): void {
  const fs = getClawforumFs();
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

  for (const clawId of clawEntries.map(e => e.name)) {
    const clawDir = path.join(getClawforumDir(), CLAWS_DIR, clawId);
    const currentlyAlive = pm.isAlive(clawId);
    const wasAlive = clawPreviouslyAlive.get(clawId);

    if (currentlyAlive) {
      everSpawned.add(clawId);
    }

    if ((wasAlive === true || everSpawned.has(clawId)) && !currentlyAlive) {
      const detectMethod = wasAlive === true ? 'previous_tick' : 'ever_spawned';

      // Dedup: skip re-emitting crash_notification for already-notified claw
      if (clawPreviouslyNotified.has(clawId)) {
        audit.write(
          WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_DEDUPED,
          `claw=${clawId}`,
          `reason=already_notified`,
        );
        clawPreviouslyAlive.set(clawId, currentlyAlive);
        continue;
      }

      // Only notify motion when there is an active/paused contract (no notification needed if claw stops without a contract)
      if (!clawHasContract(clawDir, audit)) {
        log(`[watchdog] Claw ${clawId} stopped (no active contract, skipping notification) [${detectMethod}]`);
        audit.write(WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED, `claw=${clawId}`, 'has_contract=false', `detected_by=${detectMethod}`);
        clawPreviouslyAlive.set(clawId, currentlyAlive);
        continue;
      }
      log(`[watchdog] Claw ${clawId} crashed (${detectMethod}, was alive, now stopped)`);
      audit.write(WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_DETECTED, `claw=${clawId}`, 'has_contract=true', `detected_by=${detectMethod}`);

      // Collect snapshot info
      const snapshot = gatherClawSnapshot(clawDir, pm, clawId);
      const lastEventsStr = snapshot.lastAuditEvents?.length
        ? `; last_events: ${snapshot.lastAuditEvents.map(e => e.replace(/\t/g, '|')).join(' >> ')}`
        : '';
      const body = `contract: ${snapshot.contract}, outbox_pending: ${snapshot.outboxPending}${lastEventsStr}`;

      const { fs: motionFs, audit: motionAudit } = getMotionContext();
      try {
        new InboxWriter(motionFs, path.join(getNamedSubrootDir('motion'), 'inbox', 'pending'), motionAudit).writeSync({
          type: 'crash_notification',
          source: clawId,
          priority: 'high',
          body,
        });
      } catch (err) {
        audit.write(WATCHDOG_AUDIT_EVENTS.CLAW_CRASH_NOTIFY_DROPPED, `claw=${clawId}`, `error=${err instanceof Error ? err.message : String(err)}`);
      }

      clawPreviouslyNotified.set(clawId, Date.now());
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
