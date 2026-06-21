/**
 * @module L6.Watchdog.Pid
 * PID file management — 0 module state 依赖（仅 fs）
 */

import { getWorkspaceRoot } from '../foundation/install-paths.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from "../foundation/utils/index.js";
import { getChestnutFs } from './watchdog-context.js';
import { isAlive, isPidArgvMatching } from '../foundation/process-exec/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { getAuditWriter } from './watchdog-context.js';

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

import { isFileNotFound } from '../foundation/fs/index.js';

/** 1:1 保 watchdog.ts:85-89 */
export function writeWatchdogPid(fsFactory: (baseDir: string) => FileSystem, pid: number): void {
  const root = getWorkspaceRoot();
  const fs = getChestnutFs(fsFactory);
  fs.writeAtomicSync('watchdog.pid', JSON.stringify({ pid, root }));
}

/** 1:1 保 watchdog.ts:91-98 */
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

/** 1:1 保 watchdog.ts:121-130 */
export function getWatchdogPid(fsFactory: (baseDir: string) => FileSystem): number | null {
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
  } catch {
    // ENOENT etc — silent (既有合规)
    return null;
  }
}

export class WatchdogPidForeignWorkspaceError extends Error {
  constructor(public foreignPid: number, public foreignRoot: string, public currentRoot: string) {
    super(`Watchdog PID file owned by foreign workspace: pid=${foreignPid} root=${foreignRoot} current=${currentRoot}`);
    this.name = 'WatchdogPidForeignWorkspaceError';
  }
}

/** 1:1 保 watchdog.ts:132-149 */
export function isWatchdogAlive(fsFactory: (baseDir: string) => FileSystem): boolean {
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
