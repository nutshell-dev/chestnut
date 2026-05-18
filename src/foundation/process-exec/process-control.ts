/**
 * @module L1.ProcessExec
 *
 * Process control primitives: kill / isAlive.
 *
 * POSIX-only (Stage 2 跨 OS 同 sh 硬编码 / Transport UDS 同型决策)。
 */

import { ProcessExecError } from './types.js';
import { getProcessStartTime } from './process-starttime.js';

export type Signal = 'TERM' | 'KILL' | 'INT';

const SIGNAL_MAP: Record<Signal, NodeJS.Signals> = {
  TERM: 'SIGTERM',
  KILL: 'SIGKILL',
  INT: 'SIGINT',
};

/**
 * Send signal to process. Fire-and-forget (no wait-and-verify).
 *
 * @throws ProcessExecError if process.kill fails (other than ESRCH).
 *         ESRCH (no such process) is silently ignored — already gone counts as success.
 */
export function kill(pid: number, signal: Signal): void {
  try {
    process.kill(pid, SIGNAL_MAP[signal]);
  } catch (err: any) {
    if (err?.code === 'ESRCH') return;
    throw new ProcessExecError({
      message: `kill(${pid}, ${signal}) failed: ${err?.message ?? String(err)}`,
      code: err?.code,
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
export function isAlive(pid: number, expectedStartTime?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    if (err?.code === 'EPERM') return true;
    return false;
  }
  if (expectedStartTime === undefined || process.platform === 'win32') return true; // skip verify
  const actualStartTime = getProcessStartTime(pid);
  if (actualStartTime === undefined) return true; // ps fail / fall back to kill(0) only
  return actualStartTime === expectedStartTime;
}
