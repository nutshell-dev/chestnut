/**
 * @module L6.Watchdog.State
 * Watchdog state persistence — load/save crash Map + restart state
 *
 * phase 1383 (P2b): inactivity maps (lastInactivityNotified/inactivityNotifyCount) 退场。
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from "../foundation/node-utils/index.js";
import { getChestnutFs, getAuditWriter, clawStateAPI, clawRestartStateAPI, motionRestartStateAPI, type RestartState } from './watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';

import { isFileNotFound } from '../foundation/fs/index.js';

const CURRENT_WATCHDOG_SCHEMA_VERSION = 2;

interface WatchdogState {
  schema_version: number;  // phase 311 strict-end: require explicit (no fallback)
  // phase 1383: lastInactivityNotified/inactivityNotifyCount 退场
  // NEW — phase 1072: crash-detection state persisted for watchdog self-recovery
  clawPreviouslyAlive: Record<string, boolean>;
  everSpawned: string[];
  // NEW v2 — phase 1269: crash notification dedup persisted
  clawPreviouslyNotified?: Record<string, number>;
  // NEW v2 additive — phase 1164: motion restart durable state
  motionRestart?: RestartState;
  // NEW phase 1380: per-claw restart/backoff/circuit durable state
  clawRestart?: Record<string, RestartState>;
}

function normalizeRestartState(value: unknown): RestartState {
  if (typeof value !== 'object' || value === null) {
    return { status: 'closed', consecutiveAttempts: 0 };
  }
  const s = value as Record<string, unknown>;
  if (s.status === 'closed' && s.consecutiveAttempts === 0) {
    return { status: 'closed', consecutiveAttempts: 0 };
  }
  if (
    s.status === 'retrying'
    && Number.isInteger(s.consecutiveAttempts)
    && (s.consecutiveAttempts as number) > 0
    && typeof s.nextAttemptAt === 'number'
    && Number.isFinite(s.nextAttemptAt)
    && typeof s.awaitingStability === 'boolean'
  ) {
    return {
      status: 'retrying',
      consecutiveAttempts: s.consecutiveAttempts as number,
      nextAttemptAt: s.nextAttemptAt,
      awaitingStability: s.awaitingStability,
    };
  }
  if (
    s.status === 'open'
    && Number.isInteger(s.consecutiveAttempts)
    && (s.consecutiveAttempts as number) > 0
    && typeof s.openedAt === 'number'
    && Number.isFinite(s.openedAt)
  ) {
    return {
      status: 'open',
      consecutiveAttempts: s.consecutiveAttempts as number,
      openedAt: s.openedAt,
    };
  }
  throw new Error('watchdog-state.json invalid motionRestart');
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
    const motionRestart = normalizeRestartState(state.motionRestart);
    motionRestartStateAPI.replace(motionRestart);

    // phase 1380: per-claw restart state — 逐条目 normalize，坏条目 drop + audit（不整体失败）
    clawRestartStateAPI.pruneStale(new Set());
    if (state.clawRestart !== undefined) {
      if (typeof state.clawRestart !== 'object' || state.clawRestart === null || Array.isArray(state.clawRestart)) {
        getAuditWriter()?.write(
          WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED,
          `reason=claw_restart_not_record`,
          `error=expected object`,
        );
      } else {
        for (const [clawId, raw] of Object.entries(state.clawRestart)) {
          try {
            clawRestartStateAPI.set(clawId, normalizeRestartState(raw));
          } catch (entryErr) {
            getAuditWriter()?.write(
              WATCHDOG_AUDIT_EVENTS.STATE_LOAD_FAILED,
              `reason=claw_restart_entry_invalid`,
              `claw=${clawId}`,
              `error=${getAuditWriter()?.message(formatErr(entryErr)) ?? formatErr(entryErr)}`,
            );
          }
        }
      }
    }
  } catch (err) {
    if (isFileNotFound(err)) {
      // 首次启动 — 从空状态开始
      return;
    }

    // corrupt path: Maps reset to empty (mirror ENOENT) / partial populate from broken state must not leak / per phase 636
    clawStateAPI.replaceAll({
      clawPreviouslyAlive: {},
      everSpawned: [],
      clawPreviouslyNotified: {},
    });
    motionRestartStateAPI.reset();
    clawRestartStateAPI.pruneStale(new Set());

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
    motionRestart: motionRestartStateAPI.snapshot(),
    clawRestart: Object.fromEntries(clawRestartStateAPI.entries()),
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
