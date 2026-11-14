/**
 * @module L6.Watchdog.Pid
 * PID file management — persisted identity is decoded/inspected by ProcessExec.
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
export { _setPidArgvVerifierForTest } from './process-capabilities.js';
import { getChestnutFs } from './watchdog-context.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { getAuditWriter } from './watchdog-context.js';
import {
  inspectWatchdogOwnerRecord,
  inspectWatchdogProcessRef,
  type WatchdogProcessRefInspection,
} from './process-capabilities.js';
import type { WatchdogProcessDeps } from './types.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import {
  inspectActive,
  currentLegacyParentRoot,
  legacyParentMatchesInstance,
  type WatchdogOwnerRecord,
} from './watchdog-ownership.js';

export { inspectWatchdogOwnerRecord } from './process-capabilities.js';

interface WatchdogInspectedMetadata {
  source: 'active' | 'legacy';
  pid: number;
  workspaceRoot: string;
  owner?: WatchdogOwnerRecord;
}

export type WatchdogOwnerInspection =
  | { kind: 'none' }
  | {
      kind: 'malformed';
      source: 'active' | 'legacy';
      cause: unknown;
      raw?: string;
    }
  | {
      kind: 'unknown';
      source: 'legacy';
      reason: 'read_failed';
      cause: unknown;
    }
  | (WatchdogInspectedMetadata & WatchdogProcessRefInspection);

export class WatchdogOwnerInspectionError extends Error {
  constructor(
    readonly inspection: Extract<WatchdogOwnerInspection, { kind: 'unknown' | 'malformed' }>,
  ) {
    super(
      `Watchdog owner inspection is ${inspection.kind}: ` +
      `source=${inspection.source} reason=${formatErr(
        inspection.kind === 'malformed' ? inspection.cause : inspection.reason,
      )}`,
    );
    this.name = 'WatchdogOwnerInspectionError';
  }
}

function auditMalformedActiveQuery(ctx: string, cause: unknown): void {
  const auditWriter = getAuditWriter();
  auditWriter?.write(
    WATCHDOG_AUDIT_EVENTS.OWNERSHIP_MALFORMED_ACTIVE,
    `ctx=${ctx}`,
    `error=${auditWriter?.message(formatErr(cause)) ?? formatErr(cause)}`,
  );
}

// Phase 1203 Step E: runtime writer 已删除 —— 新版 Watchdog 运行期不创建/覆盖/更新
// `watchdog.pid`；本文件只保留 legacy reader / migration / stop 兼容清理能力。

/** 1:1 保 watchdog.ts:91-98；仅 stop 兼容清理 legacy 输入用 */
export function removeWatchdogPid(fsFactory: (baseDir: string) => FileSystem): void {
  try {
    const fs = getChestnutFs(fsFactory);
    fs.deleteSync('watchdog.pid');
  } catch {
    // silent: stale pid cleanup best-effort
  }
}

interface WatchdogPidShape {
  pid: number;
  root: string;
}

function validatePidShape(parsed: unknown): parsed is WatchdogPidShape {
  return (
    typeof parsed === 'object' && parsed !== null &&
    typeof (parsed as Partial<WatchdogPidShape>).pid === 'number' &&
    typeof (parsed as Partial<WatchdogPidShape>).root === 'string'
  );
}

function backupCorruptPid(
  fsFactory: (baseDir: string) => FileSystem,
  _content: string,
  err: unknown,
): void {
  const fs = getChestnutFs(fsFactory);
  const backupPath = `watchdog.pid.corrupt-${Date.now()}`;
  let moveOk = true;
  let moveErr: unknown = undefined;
  try {
    fs.moveSync('watchdog.pid', backupPath);
  } catch (mErr) {
    moveOk = false;
    moveErr = mErr;
  }
  const auditWriter = getAuditWriter();
  auditWriter?.write(
    WATCHDOG_AUDIT_EVENTS.PID_CORRUPT,
    `backup=${backupPath}`,
    `move_ok=${moveOk}`,
    ...(moveOk ? [] : [`move_error=${auditWriter?.message(formatErr(moveErr)) ?? formatErr(moveErr)}`]),
    `error=${auditWriter?.message(formatErr(err)) ?? formatErr(err)}`,
  );
}

/** 1:1 保 watchdog.ts:121-130；active owner 优先、legacy watchdog.pid 为 fallback。 */
export function getWatchdogPid(fsFactory: (baseDir: string) => FileSystem): number | null {
  const fs = getChestnutFs(fsFactory);
  const inspection = inspectActive(fs);
  if (inspection.status === 'ok') return inspection.owner.pid;
  if (inspection.status === 'malformed') {
    auditMalformedActiveQuery('pid_query', inspection.cause);
    return null;
  }
  return getLegacyWatchdogPid(fsFactory);
}

function getLegacyWatchdogPid(fsFactory: (baseDir: string) => FileSystem): number | null {
  try {
    const fs = getChestnutFs(fsFactory);
    const content = fs.readSync('watchdog.pid');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      backupCorruptPid(fsFactory, content, e);
      return null;
    }
    if (!validatePidShape(parsed)) {
      backupCorruptPid(fsFactory, content, new Error('shape_mismatch'));
      return null;
    }
    return parsed.pid;
  } catch (err) {
    if (isFileNotFound(err)) return null;
    const auditWriter = getAuditWriter();
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.PID_READ_FAILED,
      `reason=${auditWriter?.message(formatErr(err)) ?? formatErr(err)}`,
    );
    return null;
  }
}

function inspectLegacyWatchdogOwner(
  fsFactory: (baseDir: string) => FileSystem,
  deps?: WatchdogProcessDeps,
): WatchdogOwnerInspection {
  const fs = getChestnutFs(fsFactory);
  let content: string;
  try {
    content = fs.readSync('watchdog.pid');
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'none' };
    const auditWriter = getAuditWriter();
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.PID_READ_FAILED,
      'path=watchdog.pid',
      `error=${auditWriter?.message(formatErr(err)) ?? formatErr(err)}`,
    );
    return { kind: 'unknown', source: 'legacy', reason: 'read_failed', cause: err };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    // silent: malformed legacy JSON is returned as typed evidence, not deleted.
    return { kind: 'malformed', source: 'legacy', cause: error, raw: content };
  }
  if (!validatePidShape(parsed)) {
    return { kind: 'malformed', source: 'legacy', cause: 'shape_mismatch', raw: content };
  }
  return {
    source: 'legacy',
    pid: parsed.pid,
    workspaceRoot: parsed.root,
    ...inspectWatchdogProcessRef({ version: 0, pid: parsed.pid }, parsed.pid, deps),
  };
}

/** Public typed inspection for the persisted active owner or legacy fallback. */
export function inspectWatchdogOwner(
  fsFactory: (baseDir: string) => FileSystem,
  deps?: WatchdogProcessDeps,
): WatchdogOwnerInspection {
  const active = inspectActive(getChestnutFs(fsFactory));
  if (active.status === 'none') return inspectLegacyWatchdogOwner(fsFactory, deps);
  if (active.status === 'malformed') {
    return { kind: 'malformed', source: 'active', cause: active.cause };
  }
  return {
    source: 'active',
    pid: active.owner.pid,
    workspaceRoot: active.owner.workspace_root,
    owner: active.owner,
    ...inspectWatchdogOwnerRecord(active.owner, deps),
  };
}

/** Validate workspace policy after typed identity inspection; returns foreign=true. */
export function assertWatchdogOwnerWorkspace(
  inspection: Exclude<WatchdogOwnerInspection, { kind: 'none' | 'malformed' }>,
): boolean {
  if (!('workspaceRoot' in inspection)) return false;
  if (legacyParentMatchesInstance(inspection.workspaceRoot)) return false;
  if (inspection.kind === 'alive') {
    const currentRoot = currentLegacyParentRoot();
    getAuditWriter()?.write(
      WATCHDOG_AUDIT_EVENTS.PID_FOREIGN_WORKSPACE,
      `foreign_pid=${inspection.pid}`,
      `foreign_root=${inspection.workspaceRoot}`,
      `current_root=${currentRoot}`,
    );
    throw new WatchdogPidForeignWorkspaceError(
      inspection.pid,
      inspection.workspaceRoot,
      currentRoot,
    );
  }
  return true;
}

/** Phase 1203 Step B: generation guard — 仅当 legacy pid 文件属于本进程才删。 */
export function removeWatchdogPidIfOwner(
  fsFactory: (baseDir: string) => FileSystem,
  pid: number,
): void {
  try {
    const fs = getChestnutFs(fsFactory);
    const parsed: unknown = JSON.parse(fs.readSync('watchdog.pid'));
    if (
      typeof parsed === 'object' && parsed !== null &&
      (parsed as { pid?: unknown }).pid === pid
    ) {
      fs.deleteSync('watchdog.pid');
    }
  } catch {
    // silent: legacy mirror cleanup best-effort
  }
}

// === Legacy watchdog.pid 处置（Phase 1203 Step D） ===

type LegacyPidDisposition =
  | { kind: 'none' }
  | { kind: 'live'; pid: number }
  | { kind: 'foreign_live'; pid: number; root: string }
  | { kind: 'migrated' }
  | { kind: 'indeterminate'; cause: unknown }
  | { kind: 'unreadable'; cause: unknown };

/** Legacy disposal consumes the same L1 v0 decoder/inspector as active schema 1. */
export function disposLegacyWatchdogPid(
  fsFactory: (baseDir: string) => FileSystem,
  deps?: WatchdogProcessDeps,
): LegacyPidDisposition {
  const fs = getChestnutFs(fsFactory);
  let content: string;
  try {
    content = fs.readSync('watchdog.pid');
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'none' };
    const auditWriter = getAuditWriter();
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.PID_READ_FAILED,
      'path=watchdog.pid',
      `error=${auditWriter?.message(formatErr(err)) ?? formatErr(err)}`,
    );
    return { kind: 'unreadable', cause: err };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    backupCorruptPid(fsFactory, content, formatErr(e));
    return { kind: 'migrated' };
  }
  if (!validatePidShape(parsed)) {
    backupCorruptPid(fsFactory, content, 'shape_mismatch');
    return { kind: 'migrated' };
  }

  const sameWorkspace = legacyParentMatchesInstance(parsed.root);
  const fact = inspectWatchdogProcessRef({ version: 0, pid: parsed.pid }, parsed.pid, deps);
  if (fact.kind === 'unknown') return { kind: 'indeterminate', cause: fact };
  if (!sameWorkspace) {
    if (fact.kind === 'alive') {
      return { kind: 'foreign_live', pid: parsed.pid, root: parsed.root };
    }
    return migrateDeadLegacyPid(fsFactory, parsed.pid, parsed.root);
  }
  if (fact.kind === 'alive') return { kind: 'live', pid: parsed.pid };
  return migrateDeadLegacyPid(fsFactory, parsed.pid, parsed.root);
}

function migrateDeadLegacyPid(
  fsFactory: (baseDir: string) => FileSystem,
  pid: number,
  root: string,
): LegacyPidDisposition {
  const fs = getChestnutFs(fsFactory);
  const dest = `watchdog/retired/legacy-${pid}/owner.json`;
  try {
    fs.moveSync('watchdog.pid', dest);
  } catch (err) {
    if (fs.existsSync(dest) || !fs.existsSync('watchdog.pid')) return { kind: 'migrated' };
    return { kind: 'unreadable', cause: formatErr(err) };
  }
  getAuditWriter()?.write(
    WATCHDOG_AUDIT_EVENTS.OWNERSHIP_LEGACY_MIGRATED,
    `pid=${pid}`,
    `root=${root}`,
    `dest=${dest}`,
  );
  return { kind: 'migrated' };
}

export class WatchdogPidForeignWorkspaceError extends Error {
  constructor(public foreignPid: number, public foreignRoot: string, public currentRoot: string) {
    super(`Watchdog PID file owned by foreign workspace: pid=${foreignPid} root=${foreignRoot} current=${currentRoot}`);
    this.name = 'WatchdogPidForeignWorkspaceError';
  }
}

/** Typed CLI liveness; unknown/malformed stays fail-loud and never starts/spawns. */
export type WatchdogCliLiveness = 'alive' | 'not_running';
export function inspectWatchdogLivenessForCli(
  fsFactory: (baseDir: string) => FileSystem,
  deps?: WatchdogProcessDeps,
): WatchdogCliLiveness {
  const inspection = inspectWatchdogOwner(fsFactory, deps);
  if (inspection.kind === 'none') return 'not_running';
  if (inspection.kind === 'malformed') {
    if (inspection.source === 'active') {
      auditMalformedActiveQuery('alive_query', inspection.cause);
    } else {
      backupCorruptPid(fsFactory, inspection.raw ?? '', inspection.cause);
    }
    throw new WatchdogOwnerInspectionError(inspection);
  }
  const foreign = assertWatchdogOwnerWorkspace(inspection);
  if (inspection.kind === 'unknown') throw new WatchdogOwnerInspectionError(inspection);
  if (inspection.kind === 'alive') return 'alive';

  if (inspection.source === 'legacy' && foreign) {
    const currentRoot = currentLegacyParentRoot();
    getAuditWriter()?.write(
      WATCHDOG_AUDIT_EVENTS.PID_STALE_AUTO_CLEANED,
      `foreign_pid=${inspection.pid}`,
      `foreign_root=${inspection.workspaceRoot}`,
      `current_root=${currentRoot}`,
    );
    removeWatchdogPid(fsFactory);
  } else if (inspection.source === 'legacy' && inspection.reason === 'identity_changed') {
    getAuditWriter()?.write(
      WATCHDOG_AUDIT_EVENTS.PID_REUSE_DETECTED,
      `pid=${inspection.pid}`,
      `root=${inspection.workspaceRoot}`,
      'context=isWatchdogAlive',
    );
    removeWatchdogPid(fsFactory);
  }
  return 'not_running';
}
