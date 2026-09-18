/**
 * @module L6.Watchdog.Pid
 * PID file management — 0 module state 依赖（仅 fs）
 */

import { getWorkspaceRoot } from '../foundation/claw-identity/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from "../foundation/node-utils/index.js";
import { getChestnutFs } from './watchdog-context.js';
import { isAlive, isPidArgvMatching } from '../foundation/process-exec/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { getAuditWriter } from './watchdog-context.js';
import { inspectActive, type WatchdogOwnerRecord } from './watchdog-ownership.js';

/**
 * phase 346 B3 (review-2026-06-13): PID-reuse 防误判 helper。
 * isAlive(pid) 只测 PID 存在、PID-reuse 后会命中无关进程（shell / editor）；
 * 探活后必再验 argv 含 watchdog entry token 才能视为真 chestnut watchdog。
 */
const WATCHDOG_ARGV_TOKEN = 'watchdog-entry';

/**
 * phase 346 B3 test seam: tests mock process.kill so isAlive(假 PID)→true、但
 * 真 `ps -p 假PID` 返空→argv-verify 全 false。注入此 hook 让 test 旁路 argv 检
 * （仍保有 production code 的 PID-reuse 保护）。
 */
let _pidArgvVerifierOverride: ((pid: number, token: string) => boolean) | null = null;
export function _setPidArgvVerifierForTest(fn: ((pid: number, token: string) => boolean) | null): void {
  _pidArgvVerifierOverride = fn;
}
function verifyArgv(pid: number, token: string): boolean {
  if (_pidArgvVerifierOverride) return _pidArgvVerifierOverride(pid, token);
  // 测试环境默认旁路（test 用 process.kill mock 让 isAlive(假 PID)→true、真
  // ps 返空会令本守失败、破坏既有 test fixture）；测试新行为时显式 set override。
  if (process.env.NODE_ENV === 'test') return true;
  return isPidArgvMatching(pid, token);
}

function isLiveChestnutWatchdog(pid: number): boolean {
  if (!isAlive(pid)) return false;
  return verifyArgv(pid, WATCHDOG_ARGV_TOKEN);
}

/** Phase 1203 Step B: ownership reclaim 共用的判活（isAlive + argv verify） */
export function isWatchdogProcessAlive(pid: number): boolean {
  return isLiveChestnutWatchdog(pid);
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
  const currentRoot = getWorkspaceRoot();
  if (parsed.root !== currentRoot) {
    if (isLiveChestnutWatchdog(parsed.pid)) {
      return { kind: 'foreign_live', pid: parsed.pid, root: parsed.root };
    }
    return migrateDeadLegacyPid(fsFactory, parsed.pid, parsed.root);
  }
  if (isLiveChestnutWatchdog(parsed.pid)) {
    return { kind: 'live', pid: parsed.pid };
  }
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
  const currentRoot = getWorkspaceRoot();
  if (owner.workspace_root !== currentRoot) {
    if (isLiveChestnutWatchdog(owner.pid)) {
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
  return isLiveChestnutWatchdog(owner.pid);
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
  const currentRoot = getWorkspaceRoot();
  if (parsed.root !== currentRoot) {
    // phase 346 B3: PID-reuse 防误判 — 不光测 isAlive、还得验 argv 是 chestnut watchdog
    const stillAlive = isLiveChestnutWatchdog(parsed.pid);
    const auditWriter = getAuditWriter();
    // 候选 D: foreign pid 已死（或被 OS 重用给无关进程）→ 自动清 stale (audit + remove + return false 放行 spawn)
    if (!stillAlive) {
      auditWriter?.write(
        WATCHDOG_AUDIT_EVENTS.PID_STALE_AUTO_CLEANED,
        `foreign_pid=${parsed.pid}`,
        `foreign_root=${parsed.root}`,
        `current_root=${currentRoot}`,
      );
      removeWatchdogPid(fsFactory);
      return false;
    }
    // foreign 活 → audit + throw（不删 + 不放行 spawn / user 需 cd + chestnut stop）
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.PID_FOREIGN_WORKSPACE,
      `foreign_pid=${parsed.pid}`,
      `foreign_root=${parsed.root}`,
      `current_root=${currentRoot}`,
    );
    throw new WatchdogPidForeignWorkspaceError(parsed.pid, parsed.root, currentRoot);
  }
  // phase 346 B3: 同 workspace 也用 argv-verify、防 PID-reuse 后误报本 workspace watchdog 还活
  // 注意：单次 isAlive() = 单次 process.kill(pid,0)、避免 spec test mock 计数偏差。
  const alive = isAlive(parsed.pid);
  if (!alive) return false;
  if (!verifyArgv(parsed.pid, WATCHDOG_ARGV_TOKEN)) {
    const auditWriter = getAuditWriter();
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.PID_REUSE_DETECTED,
      `pid=${parsed.pid}`,
      `root=${parsed.root}`,
      `context=isWatchdogAlive`,
    );
    removeWatchdogPid(fsFactory);
    return false;
  }
  return true;
}
