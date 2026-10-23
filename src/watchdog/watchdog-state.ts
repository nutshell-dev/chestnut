/**
 * @module L6.Watchdog.State
 * Watchdog state persistence — load/save durable restart maps.
 *
 * Phase 1455 Step A: 磁盘位置归位 `watchdog/state.json`（WATCHDOG_PATHS.state）。
 * phase 1890 Step J：迁移协议退役——读写只走新路径，不再有 legacy root
 * `watchdog-state.json` 回退（无老版本部署存量）。
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from "../foundation/node-utils/index.js";
import {
  getChestnutFs, getAuditWriter, motionRestartStateAPI,
  type MotionRestartState,
} from './watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { WATCHDOG_PATHS } from './layout.js';

import { isFileNotFound } from '../foundation/fs/index.js';

const CURRENT_WATCHDOG_SCHEMA_VERSION = 3;

interface WatchdogState {
  schema_version: number;
  motionRestart?: MotionRestartState;
  // Phase 1974 Step C: executorRestart 键随 executor recovery 退役——
  // 旧 state.json 残留键 JSON.parse 后不读取即可（不 bump schema、不另立迁移）。
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

class WatchdogSchemaError extends Error {
  constructor(public actualVersion: unknown, public currentVersion: number) {
    super(`watchdog-state.json unknown schema_version ${String(actualVersion)} (current=${currentVersion})`);
    this.name = 'WatchdogSchemaError';
  }
}

/** 读 state 原文（phase 1890 Step J：只走新路径；FNF 由 caller 按首次启动处理）。 */
function readStateRaw(fs: FileSystem): { raw: string; statePath: string } {
  return { raw: fs.readSync(WATCHDOG_PATHS.state), statePath: WATCHDOG_PATHS.state };
}

/** Load durable watchdog state from disk. */
export function loadWatchdogState(fsFactory: (baseDir: string) => FileSystem): void {
  let statePath: string = WATCHDOG_PATHS.state;
  try {
    const fs = getChestnutFs(fsFactory);
    const read = readStateRaw(fs);
    statePath = read.statePath;
    const raw = read.raw;
    const state = JSON.parse(raw) as Record<string, unknown>;
    const stateVersion = state.schema_version;
    if (
      stateVersion === undefined
      || typeof stateVersion !== 'number'
      || stateVersion > CURRENT_WATCHDOG_SCHEMA_VERSION
    ) {
      throw new WatchdogSchemaError(stateVersion, CURRENT_WATCHDOG_SCHEMA_VERSION);
    }

    const motionRestart = normalizeMotionRestartState(state.motionRestart);
    motionRestartStateAPI.replace(motionRestart);
  } catch (err) {
    if (isFileNotFound(err)) {
      // 首次启动 — 从空状态开始
      return;
    }

    // corrupt path: reset to empty durable state
    motionRestartStateAPI.reset();

    const fs = getChestnutFs(fsFactory);
    const backupPath = `${statePath}.corrupt-${Date.now()}`;
    let moveOk = true;
    let moveErr: unknown = undefined;
    try {
      fs.moveSync(statePath, backupPath);
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
  };
  const fs = getChestnutFs(fsFactory);
  // Phase 1455 Step A: 生产写只走目标路径（writeAtomicSync 自建父目录）；
  // legacy watchdog-state.json 冻结、清退归 Phase 1455 Step C。
  fs.writeAtomicSync(WATCHDOG_PATHS.state, JSON.stringify(state, null, 2));
}

/** Best-effort crash log. */
export function writeWatchdogCrash(err: Error): void {
  try {
    const auditWriter = getAuditWriter();
    auditWriter?.write(WATCHDOG_AUDIT_EVENTS.CRASH, `error=${auditWriter?.message(formatErr(err)) ?? formatErr(err)}`);
  } catch { /* silent: crash handler must not throw */ }
}
