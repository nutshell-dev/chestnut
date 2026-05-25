/**
 * @module L6.Watchdog.State
 * Watchdog state persistence — load/save 2 Map + crash log
 */

import { getClawforumFs, getAuditWriter, lastInactivityNotified, inactivityNotifyCount, clawPreviouslyAlive, everSpawned, clawPreviouslyNotified } from './watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { AUDIT_MESSAGE_MAX_CHARS } from '../foundation/audit/index.js';
import { isFileNotFound } from '../foundation/fs/types.js';

const CURRENT_WATCHDOG_SCHEMA_VERSION = 2;

interface WatchdogState {
  schema_version?: number;  // v1 current; legacy read
  /** @deprecated legacy fallback (pre-phase-1134 watchdog-state schema_version invariant land)
   *  SUNSET per phase 1180 r129 E fork: 30 天 audit 0 触发 `WATCHDOG_STATE_LEGACY_VERSION_FALLBACK` (NEW const if needed) → r130+ phase 删 version? field + cascade reader */
  version?: number;
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
export function loadWatchdogState(): void {
  try {
    const fs = getClawforumFs();
    const raw = fs.readSync('watchdog-state.json');
    const state = JSON.parse(raw) as WatchdogState;
    const stateVersion = state.schema_version ?? state.version;
    if (stateVersion !== undefined &&
        (typeof stateVersion !== 'number' || stateVersion > CURRENT_WATCHDOG_SCHEMA_VERSION)) {
      throw new WatchdogSchemaError(stateVersion, CURRENT_WATCHDOG_SCHEMA_VERSION);
    }
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
    for (const [k, v] of Object.entries(state.clawPreviouslyNotified ?? {})) {
      clawPreviouslyNotified.set(k, v);
    }
  } catch (err) {
    if (isFileNotFound(err)) {
      // 首次启动 — 从空状态开始
      return;
    }

    // corrupt path: Maps reset to empty (mirror ENOENT) / partial populate from broken state must not leak / per phase 636
    lastInactivityNotified.clear();
    inactivityNotifyCount.clear();
    clawPreviouslyAlive.clear();
    everSpawned.clear();
    clawPreviouslyNotified.clear();

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
    const isSchemaErr = err instanceof WatchdogSchemaError;
    const auditEvent = isSchemaErr ? WATCHDOG_AUDIT_EVENTS.STATE_SCHEMA_INVALID : WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED;
    auditWriter?.write(
      auditEvent,
      `backup=${backupPath}`,
      ...(isSchemaErr ? [`reason=unknown_schema_version`, `actual=${String((err as WatchdogSchemaError).actualVersion)}`, `current=${CURRENT_WATCHDOG_SCHEMA_VERSION}`] : []),
      `move_ok=${moveOk}`,
      ...(moveOk ? [] : [`move_error=${(moveErr instanceof Error ? moveErr.message : String(moveErr)).slice(0, AUDIT_MESSAGE_MAX_CHARS)}`]),
      `error=${(err as Error).message?.slice(0, AUDIT_MESSAGE_MAX_CHARS) ?? String(err)}`,
    );
  }
}

/** 1:1 保 watchdog.ts:240-249 / save 2 Map */
export function saveWatchdogState(): void {
  const state: WatchdogState = {
    schema_version: 2,
    lastInactivityNotified: Object.fromEntries(lastInactivityNotified),
    inactivityNotifyCount: Object.fromEntries(inactivityNotifyCount),
    // NEW — phase 1072
    clawPreviouslyAlive: Object.fromEntries(clawPreviouslyAlive),
    everSpawned: Array.from(everSpawned),
    // NEW — phase 1269
    clawPreviouslyNotified: Object.fromEntries(clawPreviouslyNotified),
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
