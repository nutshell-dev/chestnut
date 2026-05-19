/**
 * @module L6.Watchdog.State
 * Watchdog state persistence — load/save 2 Map + crash log
 */

import * as path from 'path';
import { getClawforumDir, getClawforumFs, getAuditWriter, lastInactivityNotified, inactivityNotifyCount, clawPreviouslyAlive, everSpawned } from './watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { AUDIT_MESSAGE_MAX_CHARS } from '../foundation/audit/index.js';

interface WatchdogState {
  version?: number;  // v0 = absent (legacy), v1 = current
  lastInactivityNotified: Record<string, number>;
  inactivityNotifyCount: Record<string, number>;
  // NEW — phase 1072: crash-detection state persisted for watchdog self-recovery
  clawPreviouslyAlive: Record<string, boolean>;
  everSpawned: string[];
}

/** 1:1 保 watchdog.ts:204-206 */
function getWatchdogStateFile(): string {
  return path.join(getClawforumDir(), 'watchdog-state.json');
}

/** 1:1 保 watchdog.ts:208-238 / load 2 Map */
export function loadWatchdogState(): void {
  try {
    const fs = getClawforumFs();
    const raw = fs.readSync('watchdog-state.json');
    const state = JSON.parse(raw) as WatchdogState;
    // version ?? 0 — 旧文件无 version 字段，视为 v0，兼容加载
    for (const [k, v] of Object.entries(state.lastInactivityNotified ?? {})) {
      lastInactivityNotified.set(k, v);
    }
    for (const [k, v] of Object.entries(state.inactivityNotifyCount ?? {})) {
      inactivityNotifyCount.set(k, v);
    }
    for (const [k, v] of Object.entries(state.clawPreviouslyAlive ?? {})) {
      clawPreviouslyAlive.set(k, v);
    }
    for (const id of state.everSpawned ?? []) {
      everSpawned.add(id);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 首次启动 — 从空状态开始
      return;
    }

    // corrupt path: Maps reset to empty (mirror ENOENT) / partial populate from broken state must not leak / per phase 636
    lastInactivityNotified.clear();
    inactivityNotifyCount.clear();
    clawPreviouslyAlive.clear();
    everSpawned.clear();

    const fs = getClawforumFs();
    const backupPath = `watchdog-state.json.corrupt-${Date.now()}`;
    let moveOk = true;
    let moveErr: unknown = undefined;
    try {
      fs.moveSync('watchdog-state.json', backupPath);
    } catch (mErr) {
      moveOk = false;
      moveErr = mErr;
    }
    const auditWriter = getAuditWriter();
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED,
      `backup=${backupPath}`,
      `move_ok=${moveOk}`,
      ...(moveOk ? [] : [`move_error=${(moveErr instanceof Error ? moveErr.message : String(moveErr)).slice(0, AUDIT_MESSAGE_MAX_CHARS)}`]),
      `error=${(err as Error).message?.slice(0, AUDIT_MESSAGE_MAX_CHARS) ?? String(err)}`,
    );
  }
}

/** 1:1 保 watchdog.ts:240-249 / save 2 Map */
export function saveWatchdogState(): void {
  const state: WatchdogState = {
    version: 1,
    lastInactivityNotified: Object.fromEntries(lastInactivityNotified),
    inactivityNotifyCount: Object.fromEntries(inactivityNotifyCount),
    // NEW — phase 1072
    clawPreviouslyAlive: Object.fromEntries(clawPreviouslyAlive),
    everSpawned: Array.from(everSpawned),
  };
  const fs = getClawforumFs();
  fs.writeAtomicSync('watchdog-state.json', JSON.stringify(state, null, 2));
}

/** 1:1 保 watchdog.ts:264-269 */
export function writeWatchdogCrash(err: Error): void {
  try {
    const auditWriter = getAuditWriter();
    auditWriter?.write(WATCHDOG_AUDIT_EVENTS.CRASH, `error=${err.message?.slice(0, AUDIT_MESSAGE_MAX_CHARS) ?? String(err)}`);
  } catch { /* ignore: crash handler 不抛 */ }
}
