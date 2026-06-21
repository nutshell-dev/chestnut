/**
 * @module L6.Watchdog.State
 * Watchdog state persistence — load/save 2 Map + crash log
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from "../foundation/utils/index.js";
import { getChestnutFs, getAuditWriter, clawStateAPI } from './watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';

import { isFileNotFound } from '../foundation/fs/index.js';

const CURRENT_WATCHDOG_SCHEMA_VERSION = 2;

interface WatchdogState {
  schema_version: number;  // phase 311 strict-end: require explicit (no fallback)
  lastInactivityNotified: Record<string, number>;
  inactivityNotifyCount: Record<string, number>;
  // NEW — phase 1072: crash-detection state persisted for watchdog self-recovery
  clawPreviouslyAlive: Record<string, boolean>;
  everSpawned: string[];
  // NEW v2 — phase 1269: crash notification dedup persisted
  clawPreviouslyNotified?: Record<string, number>;
}

class WatchdogSchemaError extends Error {
  constructor(public actualVersion: unknown, public currentVersion: number) {
    super(`watchdog-state.json unknown schema_version ${String(actualVersion)} (current=${currentVersion})`);
    this.name = 'WatchdogSchemaError';
  }
}

/** 1:1 保 watchdog.ts:208-238 / load 2 Map */
export function loadWatchdogState(fsFactory: (baseDir: string) => FileSystem): void {
  try {
    const fs = getChestnutFs(fsFactory);
    const raw = fs.readSync('watchdog-state.json');
    const state = JSON.parse(raw) as WatchdogState;
    // phase 311 ML#9 strict: require schema_version explicit、delete legacy version? graceful-read fallback
    const stateVersion = state.schema_version;
    if (stateVersion === undefined ||
        typeof stateVersion !== 'number' || stateVersion > CURRENT_WATCHDOG_SCHEMA_VERSION) {
      throw new WatchdogSchemaError(stateVersion, CURRENT_WATCHDOG_SCHEMA_VERSION);
    }
    clawStateAPI.replaceAll(state);
  } catch (err) {
    if (isFileNotFound(err)) {
      // 首次启动 — 从空状态开始
      return;
    }

    // corrupt path: Maps reset to empty (mirror ENOENT) / partial populate from broken state must not leak / per phase 636
    clawStateAPI.replaceAll({
      lastInactivityNotified: {},
      inactivityNotifyCount: {},
      clawPreviouslyAlive: {},
      everSpawned: [],
      clawPreviouslyNotified: {},
    });

    const fs = getChestnutFs(fsFactory);
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
    const isSchemaErr = err instanceof WatchdogSchemaError;
    const auditEvent = isSchemaErr ? WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID : WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED;
    auditWriter?.write(
      auditEvent,
      `backup=${backupPath}`,
      ...(isSchemaErr ? [`reason=unknown_schema_version`, `actual=${String((err as WatchdogSchemaError).actualVersion)}`, `current=${CURRENT_WATCHDOG_SCHEMA_VERSION}`] : []),
      `move_ok=${moveOk}`,
      ...(moveOk ? [] : [`move_error=${auditWriter?.message(formatErr(moveErr)) ?? formatErr(moveErr)}`]),
      `error=${auditWriter?.message(formatErr(err)) ?? formatErr(err)}`,
    );
  }
}

/** 1:1 保 watchdog.ts:240-249 / save 2 Map */
export function saveWatchdogState(fsFactory: (baseDir: string) => FileSystem): void {
  const state: WatchdogState = {
    schema_version: 2,
    ...clawStateAPI.snapshot(),
  };
  const fs = getChestnutFs(fsFactory);
  fs.writeAtomicSync('watchdog-state.json', JSON.stringify(state, null, 2));
}

/** 1:1 保 watchdog.ts:264-269 */
export function writeWatchdogCrash(err: Error): void {
  try {
    const auditWriter = getAuditWriter();
    auditWriter?.write(WATCHDOG_AUDIT_EVENTS.CRASH, `error=${auditWriter?.message(formatErr(err)) ?? formatErr(err)}`);
  } catch { /* silent: crash handler must not throw */ }
}
