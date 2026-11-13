/**
 * @module L6.Watchdog.Pid
 * PID file management — 0 module state 依赖（仅 fs）
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from "../foundation/node-utils/index.js";
import { getChestnutFs } from './watchdog-context.js';
import type { ProcessTarget } from '../foundation/process-exec/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { getAuditWriter } from './watchdog-context.js';
import {
  _setPidArgvVerifierForTest,
  observeWatchdogProcess,
  watchdogProcessTarget,
  WatchdogProcessObservationError,
  type WatchdogProcessFact,
} from './process-capabilities.js';
import type { WatchdogProcessDeps } from './types.js';

export { _setPidArgvVerifierForTest } from './process-capabilities.js';
import {
  inspectActive,
  currentLegacyParentRoot,
  legacyParentMatchesInstance,
  type WatchdogOwnerRecord,
} from './watchdog-ownership.js';

/** Ownership callers consume typed business facts; unknown is never reclaimable. */
export function observeWatchdogOwner(
  pid: number,
  startTime?: string,
  deps?: WatchdogProcessDeps,
): WatchdogProcessFact {
  return observeWatchdogProcess(pid, startTime, deps);
}

function isLiveChestnutWatchdog(pid: number, startTime?: string): boolean {
  const fact = observeWatchdogOwner(pid, startTime);
  if (fact.kind === 'indeterminate') throw new WatchdogProcessObservationError(fact);
  return fact.kind === 'owner_active';
}

/** Backward-compatible boolean projection; indeterminate observations fail loud. */
export function isWatchdogProcessAlive(pid: number, startTime?: string): boolean {
  return isLiveChestnutWatchdog(pid, startTime);
}

function auditMalformedActiveQuery(ctx: string, cause: unknown): void {
  const auditWriter = getAuditWriter();
  auditWriter?.write(
    WATCHDOG_AUDIT_EVENTS.OWNERSHIP_MALFORMED_ACTIVE,
    `ctx=${ctx}`,
    `error=${auditWriter?.message(formatErr(cause)) ?? formatErr(cause)}`,
  );
}

import { isFileNotFound } from '../foundation/fs/index.js';

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

function backupCorruptPid(fsFactory: (baseDir: string) => FileSystem, _content: string, err: unknown): void {
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

/** 1:1 保 watchdog.ts:121-130；Phase 1203 Step B: active owner 优先、legacy watchdog.pid 为 fallback 边界 */
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

/** Resolve the persisted identity for Watchdog's control entry, not for CLI OS queries. */
export function getWatchdogProcessTarget(
  fsFactory: (baseDir: string) => FileSystem,
): ProcessTarget | null {
  const fs = getChestnutFs(fsFactory);
  const inspection = inspectActive(fs);
  if (inspection.status === 'ok') {
    return watchdogProcessTarget(inspection.owner.pid, inspection.owner.process_start_time);
  }
  if (inspection.status === 'malformed') {
    auditMalformedActiveQuery('control_target_query', inspection.cause);
    throw new Error(`Cannot stop watchdog with malformed active owner: ${formatErr(inspection.cause)}`);
  }
  const pid = getLegacyWatchdogPid(fsFactory);
  return pid === null ? null : watchdogProcessTarget(pid);
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

/** Phase 1203 Step B: generation guard — 仅当 legacy pid 文件属于本进程才删（防旧 generation 迟到 shutdown 删新 owner 镜像） */
export function removeWatchdogPidIfOwner(fsFactory: (baseDir: string) => FileSystem, pid: number): void {
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

/**
 * legacy `watchdog.pid` 处置边界（仅在无 active owner 时由 candidate 调用）。
 * - live（同 workspace / PID-reuse 已 argv 检）→ 保守阻止接管；
 * - foreign live → foreign_live（caller fail-loud）；
 * - dead / PID-reuse / foreign dead → 保留证据迁移到 `watchdog/retired/legacy-<pid>/owner.json` 后放行；
 * - corrupt → 走既有 `watchdog.pid.corrupt-<ts>` quarantine 后放行。
 * legacy 文件不得直接删除；migration destination 由 pid 稳定派生（不用当前时间），
 * 两个 migrator 产生同一 destination、rename 单 winner。
 */
export function disposLegacyWatchdogPid(fsFactory: (baseDir: string) => FileSystem): LegacyPidDisposition {
  const fs = getChestnutFs(fsFactory);
  let content: string;
  try {
    content = fs.readSync('watchdog.pid');
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'none' };
    const auditWriter = getAuditWriter();
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.PID_READ_FAILED,
      `path=watchdog.pid`,
      `error=${auditWriter?.message(formatErr(err)) ?? formatErr(err)}`,
    );
    // 读不出 = 不能证明 dead → fail-closed 阻止接管
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
  // Phase 1930 Step B：磁盘 root 语义是实例父目录，经 ownership owner 的私有适配
  // 转成实例身份再比较（相对历史记录 fail-closed，不猜当前 cwd）。
  const fact = observeWatchdogOwner(parsed.pid);
  if (fact.kind === 'indeterminate') return { kind: 'indeterminate', cause: fact.observation };
  if (!legacyParentMatchesInstance(parsed.root)) {
    if (fact.kind === 'owner_active') {
      return { kind: 'foreign_live', pid: parsed.pid, root: parsed.root };
    }
    return migrateDeadLegacyPid(fsFactory, parsed.pid, parsed.root);
  }
  if (fact.kind === 'owner_active') return { kind: 'live', pid: parsed.pid };
  // dead 或 PID-reuse（argv 不符 = 进程位被无关进程占用）
  return migrateDeadLegacyPid(fsFactory, parsed.pid, parsed.root);
}

/** dead legacy 迁移：move 原始文件为不可变证据；并发 migrator 单 winner；真 IO 失败 fail-closed */
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
    // 另一 migrator 已迁移（source 消失或 destination 已存在）→ 幂等收敛
    if (fs.existsSync(dest) || !fs.existsSync('watchdog.pid')) return { kind: 'migrated' };
    return { kind: 'unreadable', cause: formatErr(err) };
  }
  const auditWriter = getAuditWriter();
  auditWriter?.write(
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

/** 1:1 保 watchdog.ts:132-149；Phase 1203 Step B: active owner 优先、legacy watchdog.pid 为 fallback 边界 */
export function isWatchdogAlive(fsFactory: (baseDir: string) => FileSystem): boolean {
  const fs = getChestnutFs(fsFactory);
  const inspection = inspectActive(fs);
  if (inspection.status === 'ok') return isActiveOwnerAlive(inspection.owner);
  if (inspection.status === 'malformed') {
    // fail-closed：不猜 owner、不 fallback legacy
    auditMalformedActiveQuery('alive_query', inspection.cause);
    return false;
  }
  return isLegacyWatchdogAlive(fsFactory);
}

function isActiveOwnerAlive(owner: WatchdogOwnerRecord): boolean {
  const currentRoot = currentLegacyParentRoot();
  if (!legacyParentMatchesInstance(owner.workspace_root)) {
    if (isLiveChestnutWatchdog(owner.pid, owner.process_start_time)) {
      const auditWriter = getAuditWriter();
      auditWriter?.write(
        WATCHDOG_AUDIT_EVENTS.PID_FOREIGN_WORKSPACE,
        `foreign_pid=${owner.pid}`,
        `foreign_root=${owner.workspace_root}`,
        `current_root=${currentRoot}`,
      );
      throw new WatchdogPidForeignWorkspaceError(owner.pid, owner.workspace_root, currentRoot);
    }
    // foreign owner 已死：不删 active（目录 authority、recovery 走 retire），仅报死
    return false;
  }
  return isLiveChestnutWatchdog(owner.pid, owner.process_start_time);
}

function isLegacyWatchdogAlive(fsFactory: (baseDir: string) => FileSystem): boolean {
  const fs = getChestnutFs(fsFactory);
  let content: string;
  try {
    content = fs.readSync('watchdog.pid');
  } catch (err) {
    // ENOENT silent (pid 文件不在 = watchdog 不在跑、合规)
    if (isFileNotFound(err)) return false;
    // 非 ENOENT IO 错 = silent 是反模式、必 audit + throw
    const auditWriter = getAuditWriter();
    // phase 580: 加 path forensic col、forensic 解析定位是哪个 pid file 读失败
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.PID_READ_FAILED,
      `path=watchdog.pid`,
      `error=${auditWriter?.message(formatErr(err)) ?? formatErr(err)}`,
    );
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    backupCorruptPid(fsFactory, content, e);
    return false;
  }
  if (!validatePidShape(parsed)) {
    backupCorruptPid(fsFactory, content, new Error('shape_mismatch'));
    return false;
  }
  const currentRoot = currentLegacyParentRoot();
  const fact = observeWatchdogOwner(parsed.pid);
  if (fact.kind === 'indeterminate') throw new WatchdogProcessObservationError(fact);
  if (!legacyParentMatchesInstance(parsed.root)) {
    const auditWriter = getAuditWriter();
    // foreign pid 已死（或被 OS 重用给无关进程）→ 清 stale；unknown 已在上方 fail-closed。
    if (fact.kind === 'reclaimable') {
      auditWriter?.write(
        WATCHDOG_AUDIT_EVENTS.PID_STALE_AUTO_CLEANED,
        `foreign_pid=${parsed.pid}`,
        `foreign_root=${parsed.root}`,
        `current_root=${currentRoot}`,
      );
      removeWatchdogPid(fsFactory);
      return false;
    }
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.PID_FOREIGN_WORKSPACE,
      `foreign_pid=${parsed.pid}`,
      `foreign_root=${parsed.root}`,
      `current_root=${currentRoot}`,
    );
    throw new WatchdogPidForeignWorkspaceError(parsed.pid, parsed.root, currentRoot);
  }
  if (fact.kind === 'reclaimable' && fact.reason === 'identity_changed') {
    getAuditWriter()?.write(
      WATCHDOG_AUDIT_EVENTS.PID_REUSE_DETECTED,
      `pid=${parsed.pid}`,
      `root=${parsed.root}`,
      `context=isWatchdogAlive`,
    );
    removeWatchdogPid(fsFactory);
  }
  return fact.kind === 'owner_active';
}
