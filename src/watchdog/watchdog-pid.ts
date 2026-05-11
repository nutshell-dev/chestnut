/**
 * @module L6.Watchdog.Pid
 * PID file management — 0 module state 依赖（仅 fs）
 */

import { getClawforumDir, getClawforumFs } from './watchdog-context.js';
import { isAlive } from '../foundation/process-exec/index.js';
import * as path from 'path';
import { getWorkspaceRoot } from '../foundation/config/paths.js';

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

/** 1:1 保 watchdog.ts:121-130 */
export function getWatchdogPid(): number | null {
  try {
    const fs = getClawforumFs();
    const content = fs.readSync('watchdog.pid');
    const parsed = JSON.parse(content);
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

/** 1:1 保 watchdog.ts:132-149 */
export function isWatchdogAlive(): boolean {
  try {
    const fs = getClawforumFs();
    const content = fs.readSync('watchdog.pid');
    const { pid, root } = JSON.parse(content);
    if (typeof pid !== 'number') return false;
    const currentRoot = getWorkspaceRoot();
    if (root !== currentRoot) {
      removeWatchdogPid();
      return false;
    }
    return isAlive(pid);
  } catch {
    removeWatchdogPid();
    return false;
  }
}
