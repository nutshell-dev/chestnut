/**
 * @module L1.ProcessExec
 *
 * Process control primitives: kill / isAlive.
 *
 * POSIX-only (Stage 2 跨 OS 同 sh 硬编码 / Transport UDS 同型决策)。
 */

import { ProcessExecError } from './errors.js';
import { formatErr } from "../node-utils/index.js";
import { getProcessStartTime, type ProcessStartTime } from './process-starttime.js';

export type Signal = 'TERM' | 'KILL' | 'INT';

const SIGNAL_MAP: Record<Signal, NodeJS.Signals> = {
  TERM: 'SIGTERM',
  KILL: 'SIGKILL',
  INT: 'SIGINT',
};

// phase 429 Step B (review medium cross-OS observability): module-level guard、win32
// 首次调用时一次 console.error 警告 (POSIX-only module、SIGKILL 等 silent no-op)。
// POSIX 平台一次 platform check 即 return、零开销。
let win32WarnEmitted = false;
function maybeWarnWin32(op: string): void {
  if (process.platform === 'win32' && !win32WarnEmitted) {
    const msg = `[process-control WARNING] ${op} on win32: POSIX-only module, signals may silent no-op (SIGKILL particularly). See file header.`;
    console.error(msg); // console: L1 process-exec 不可 depend audit (防 L1→L2)、跨 OS warn 走 stderr 是 L1 唯一可观察 channel (phase 429 Step B)
    win32WarnEmitted = true;
  }
}

/**
 * Send signal to process. Fire-and-forget (no wait-and-verify).
 *
 * @throws ProcessExecError if process.kill fails (other than ESRCH).
 *         ESRCH (no such process) is silently ignored — already gone counts as success.
 */
export function kill(pid: number, signal: Signal): void {
  maybeWarnWin32('kill');
  try {
    process.kill(pid, SIGNAL_MAP[signal]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new ProcessExecError({
      message: `kill(${pid}, ${signal}) failed: ${formatErr(err)}`,
      code: (err as NodeJS.ErrnoException).code,
      signal,
    });
  }
}

/**
 * Check whether process is alive via POSIX signal 0 probe.
 *
 * @param expectedStartTime Optional startTime for PID-recycling defense.
 *        If provided and platform is POSIX, verifies the process startTime matches.
 * @returns true if alive (including EPERM = exists but no permission to signal).
 *          false if ESRCH or invalid pid.
 *          If startTime mismatch (PID recycled), returns false.
 */
export function isAlive(pid: number, expectedStartTime?: ProcessStartTime): boolean {
  maybeWarnWin32('isAlive');
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
  if (expectedStartTime === undefined || process.platform === 'win32') return true; // skip verify
  const actualStartTime = getProcessStartTime(pid);
  if (actualStartTime === undefined) return true; // ps fail / fall back to kill(0) only
  return actualStartTime === expectedStartTime;
}
