/**
 * @module L6.Watchdog.State
 * Watchdog state persistence — load/save durable restart maps.
 *
 * Phase 1396 Step H: legacy notification Maps retired. On first load of an old
 * state containing those fields, the original values are atomically preserved to
 * `.chestnut/watchdog/migrations/phase1396-retired-notification-state.json`
 * before the new in-memory state takes over.
 */

import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { formatErr } from "../foundation/node-utils/index.js";
import {
  getChestnutFs, getAuditWriter, motionRestartStateAPI, executorRestartStateAPI,
  type MotionRestartState, type ExecutorRestartMap, type ExecutorRestartState,
} from './watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';

import { isFileNotFound } from '../foundation/fs/index.js';

const CURRENT_WATCHDOG_SCHEMA_VERSION = 3;
const MIGRATION_RECORD_PATH = 'watchdog/migrations/phase1396-retired-notification-state.json';

interface WatchdogState {
  schema_version: number;
  motionRestart?: MotionRestartState;
  executorRestart?: ExecutorRestartMap;
}

interface LegacyNotificationFields {
  lastInactivityNotified?: Record<string, number>;
  inactivityNotifyCount?: Record<string, number>;
  clawPreviouslyAlive?: Record<string, boolean>;
  everSpawned?: string[];
  clawPreviouslyNotified?: Record<string, number>;
}

interface MigrationRecord {
  schema_version: 1;
  source_schema_version: number;
  retired_at: string;
  fields: LegacyNotificationFields;
}

function normalizeMotionRestartState(value: unknown): MotionRestartState {
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

function normalizeExecutorRestartMap(value: unknown): ExecutorRestartMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const out: ExecutorRestartMap = {};
  for (const [key, rawState] of Object.entries(raw)) {
    if (typeof rawState !== 'object' || rawState === null) continue;
    const s = rawState as Record<string, unknown>;
    if (s.status === 'closed' && s.consecutiveAttempts === 0) {
      out[key] = { status: 'closed', consecutiveAttempts: 0 };
      continue;
    }
    if (
      s.status === 'retrying'
      && Number.isInteger(s.consecutiveAttempts)
      && (s.consecutiveAttempts as number) > 0
      && typeof s.nextAttemptAt === 'number'
      && Number.isFinite(s.nextAttemptAt)
      && typeof s.awaitingStability === 'boolean'
    ) {
      out[key] = {
        status: 'retrying',
        consecutiveAttempts: s.consecutiveAttempts as number,
        nextAttemptAt: s.nextAttemptAt,
        awaitingStability: s.awaitingStability,
      };
      continue;
    }
    if (
      s.status === 'open'
      && Number.isInteger(s.consecutiveAttempts)
      && (s.consecutiveAttempts as number) > 0
      && typeof s.openedAt === 'number'
      && Number.isFinite(s.openedAt)
    ) {
      const open: ExecutorRestartState = {
        status: 'open',
        consecutiveAttempts: s.consecutiveAttempts as number,
        openedAt: s.openedAt,
      };
      if (s.sinkDelivered === true) open.sinkDelivered = true;
      out[key] = open;
      continue;
    }
    // Invalid per-claw state: skip silently rather than failing the whole map.
  }
  return out;
}

class WatchdogSchemaError extends Error {
  constructor(public actualVersion: unknown, public currentVersion: number) {
    super(`watchdog-state.json unknown schema_version ${String(actualVersion)} (current=${currentVersion})`);
    this.name = 'WatchdogSchemaError';
  }
}

function hasLegacyNotificationFields(state: Record<string, unknown>): state is Record<string, unknown> & LegacyNotificationFields {
  return (
    state.lastInactivityNotified !== undefined
    || state.inactivityNotifyCount !== undefined
    || state.clawPreviouslyAlive !== undefined
    || state.everSpawned !== undefined
    || state.clawPreviouslyNotified !== undefined
  );
}

function fieldsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function migrateLegacyNotificationState(
  fs: FileSystem,
  audit: AuditLog | null,
  sourceSchemaVersion: number,
  fields: LegacyNotificationFields,
): void {
  const record: MigrationRecord = {
    schema_version: 1,
    source_schema_version: sourceSchemaVersion,
    retired_at: new Date().toISOString(),
    fields,
  };

  if (fs.existsSync(MIGRATION_RECORD_PATH)) {
    let existing: MigrationRecord | undefined;
    try {
      existing = JSON.parse(fs.readSync(MIGRATION_RECORD_PATH)) as MigrationRecord;
    } catch (err) {
      audit?.write(
        WATCHDOG_AUDIT_EVENTS.NOTIFICATION_STATE_MIGRATION_CONFLICT,
        `reason=existing_migration_unreadable`,
        `path=${MIGRATION_RECORD_PATH}`,
        `error=${audit?.message(formatErr(err)) ?? formatErr(err)}`,
      );
      throw new Error(`Existing migration record at ${MIGRATION_RECORD_PATH} is unreadable; refusing to overwrite.`);
    }
    if (
      existing.source_schema_version === sourceSchemaVersion
      && fieldsEqual(existing.fields, fields)
    ) {
      // Idempotent re-run: same source facts already migrated.
      return;
    }
    audit?.write(
      WATCHDOG_AUDIT_EVENTS.NOTIFICATION_STATE_MIGRATION_CONFLICT,
      `reason=field_mismatch`,
      `path=${MIGRATION_RECORD_PATH}`,
    );
    throw new Error(`Migration record at ${MIGRATION_RECORD_PATH} conflicts with current legacy state; refusing to overwrite.`);
  }

  fs.ensureDirSync(path.dirname(MIGRATION_RECORD_PATH));
  fs.writeAtomicSync(MIGRATION_RECORD_PATH, JSON.stringify(record, null, 2));
  audit?.write(
    WATCHDOG_AUDIT_EVENTS.NOTIFICATION_STATE_MIGRATED,
    `path=${MIGRATION_RECORD_PATH}`,
    `source_schema_version=${sourceSchemaVersion}`,
  );
}

/** Load durable watchdog state from disk. */
export function loadWatchdogState(fsFactory: (baseDir: string) => FileSystem): void {
  try {
    const fs = getChestnutFs(fsFactory);
    const raw = fs.readSync('watchdog-state.json');
    const state = JSON.parse(raw) as Record<string, unknown>;
    const stateVersion = state.schema_version;
    if (
      stateVersion === undefined
      || typeof stateVersion !== 'number'
      || stateVersion > CURRENT_WATCHDOG_SCHEMA_VERSION
    ) {
      throw new WatchdogSchemaError(stateVersion, CURRENT_WATCHDOG_SCHEMA_VERSION);
    }

    if (hasLegacyNotificationFields(state)) {
      const audit = getAuditWriter();
      migrateLegacyNotificationState(fs, audit, stateVersion, {
        lastInactivityNotified: state.lastInactivityNotified,
        inactivityNotifyCount: state.inactivityNotifyCount,
        clawPreviouslyAlive: state.clawPreviouslyAlive,
        everSpawned: state.everSpawned,
        clawPreviouslyNotified: state.clawPreviouslyNotified,
      });
    }

    const motionRestart = normalizeMotionRestartState(state.motionRestart);
    motionRestartStateAPI.replace(motionRestart);
    executorRestartStateAPI.replace(normalizeExecutorRestartMap(state.executorRestart));
  } catch (err) {
    if (isFileNotFound(err)) {
      // 首次启动 — 从空状态开始
      return;
    }

    // corrupt path: reset to empty durable state
    motionRestartStateAPI.reset();
    executorRestartStateAPI.reset();

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

/** Persist durable watchdog state to disk. */
export function saveWatchdogState(fsFactory: (baseDir: string) => FileSystem): void {
  const state: WatchdogState = {
    schema_version: CURRENT_WATCHDOG_SCHEMA_VERSION,
    motionRestart: motionRestartStateAPI.snapshot(),
    executorRestart: executorRestartStateAPI.snapshot(),
  };
  const fs = getChestnutFs(fsFactory);
  fs.writeAtomicSync('watchdog-state.json', JSON.stringify(state, null, 2));
}

/** Best-effort crash log. */
export function writeWatchdogCrash(err: Error): void {
  try {
    const auditWriter = getAuditWriter();
    auditWriter?.write(WATCHDOG_AUDIT_EVENTS.CRASH, `error=${auditWriter?.message(formatErr(err)) ?? formatErr(err)}`);
  } catch { /* silent: crash handler must not throw */ }
}
