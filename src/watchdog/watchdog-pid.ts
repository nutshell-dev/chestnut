/**
 * @module L6.Watchdog.Pid
 * PID file management — 0 module state 依赖（仅 fs）
 */

import { getClawforumFs } from './watchdog-context.js';
import { isAlive } from '../foundation/process-exec/index.js';
import { getWorkspaceRoot } from '../foundation/paths.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { getAuditWriter } from './watchdog-context.js';
import { AUDIT_MESSAGE_MAX_CHARS } from '../foundation/audit/index.js';
import { isFileNotFound } from '../foundation/fs/types.js';

/** 1:1 保 watchdog.ts:85-89 */
export function writeWatchdogPid(pid: number): void {
  const root = getWorkspaceRoot();
  const fs = getClawforumFs();
  fs.writeAtomicSync('watchdog.pid', JSON.stringify({ pid, root }));
}

/** 1:1 保 watchdog.ts:91-98 */
export function removeWatchdogPid(): void {
  try {
    const fs = getClawforumFs();
    fs.deleteSync('watchdog.pid');
  } catch {
    // ignore
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

function backupCorruptPid(_content: string, err: unknown): void {
  const fs = getClawforumFs();
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
    ...(moveOk ? [] : [`move_error=${(moveErr instanceof Error ? moveErr.message : String(moveErr)).slice(0, AUDIT_MESSAGE_MAX_CHARS)}`]),
    `error=${(err instanceof Error ? err.message : String(err)).slice(0, AUDIT_MESSAGE_MAX_CHARS)}`,
  );
}

/** 1:1 保 watchdog.ts:121-130 */
export function getWatchdogPid(): number | null {
  try {
    const fs = getClawforumFs();
    const content = fs.readSync('watchdog.pid');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      backupCorruptPid(content, e);
      return null;
    }
    if (!validatePidShape(parsed)) {
      backupCorruptPid(content, new Error('shape_mismatch'));
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
export function isWatchdogAlive(): boolean {
  const fs = getClawforumFs();
  let content: string;
  try {
    content = fs.readSync('watchdog.pid');
  } catch (err) {
    // ENOENT silent (pid 文件不在 = watchdog 不在跑、合规)
    if (isFileNotFound(err)) return false;
    // 非 ENOENT IO 错 = silent 是反模式、必 audit + throw
    const auditWriter = getAuditWriter();
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.PID_READ_FAILED,
      `error=${(err instanceof Error ? err.message : String(err)).slice(0, AUDIT_MESSAGE_MAX_CHARS)}`,
    );
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    backupCorruptPid(content, e);
    return false;
  }
  if (!validatePidShape(parsed)) {
    backupCorruptPid(content, new Error('shape_mismatch'));
    return false;
  }
  const currentRoot = getWorkspaceRoot();
  if (parsed.root !== currentRoot) {
    const stillAlive = isAlive(parsed.pid);
    const auditWriter = getAuditWriter();
    // 候选 D: foreign pid 已死 → 自动清 stale (audit + remove + return false 放行 spawn)
    if (!stillAlive) {
      auditWriter?.write(
        WATCHDOG_AUDIT_EVENTS.PID_STALE_AUTO_CLEANED,
        `foreign_pid=${parsed.pid}`,
        `foreign_root=${parsed.root}`,
        `current_root=${currentRoot}`,
      );
      removeWatchdogPid();
      return false;
    }
    // foreign 活 → audit + throw（不删 + 不放行 spawn / user 需 cd + clawforum stop）
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.PID_FOREIGN_WORKSPACE,
      `foreign_pid=${parsed.pid}`,
      `foreign_root=${parsed.root}`,
      `current_root=${currentRoot}`,
    );
    throw new WatchdogPidForeignWorkspaceError(parsed.pid, parsed.root, currentRoot);
  }
  return isAlive(parsed.pid);
}
