/**
 * @module L6.Watchdog.Pid
 * PID file management — 0 module state 依赖（仅 fs）
 */

import { getClawforumDir, getClawforumFs } from './watchdog-context.js';
import { isAlive } from '../foundation/process-exec/index.js';
import * as path from 'path';
import { getWorkspaceRoot } from '../foundation/paths.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { getAuditWriter } from './watchdog-context.js';
import { AUDIT_MESSAGE_MAX_CHARS } from '../foundation/audit/index.js';

/** 1:1 保 watchdog.ts:50-52 */
function getWatchdogPidFile(): string {
  return path.join(getClawforumDir(), 'watchdog.pid');
}

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

function backupCorruptPid(content: string, err: unknown): void {
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

/** 1:1 保 watchdog.ts:132-149 */
export function isWatchdogAlive(): boolean {
  try {
    const fs = getClawforumFs();
    const content = fs.readSync('watchdog.pid');
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
      removeWatchdogPid();
      return false;
    }
    return isAlive(parsed.pid);
  } catch {
    removeWatchdogPid();
    return false;
  }
}
