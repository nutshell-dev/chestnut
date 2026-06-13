/**
 * @module L1.ProcessExec.ArgvVerify
 * phase 346 B3 (review-2026-06-13): verify a PID's argv before destructive action.
 *
 * 应然：仅 kill(pid, 0) 测进程活、但 PID-reuse 后 OS 把 PID 重用给完全无关的进程
 * （shell / editor / 别的工具）；watchdog orphan sweep / stale watchdog detection
 * 必须额外验进程 argv 含 chestnut 标识、不匹配 → skip + audit、不 kill。
 *
 * mac / linux 都用 `ps -o args= -p $PID`（POSIX 通用）；失败 → 保守返 false。
 */

import { spawnSync } from 'child_process';

/**
 * Read a process's argv string via `ps -o args= -p $PID`.
 * Returns empty string on any failure (process gone, ps unavailable, perm denied).
 */
export function readPidArgv(pid: number): string {
  try {
    const result = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf-8' });
    if (result.error) return '';
    if (result.status !== 0) return '';
    return (result.stdout ?? '').trim();
  } catch {
    // silent: ps spawn failure (binary missing / EAGAIN) → 返空、调用方按 PID 不可验处理（保守不 kill）
    return '';
  }
}

/**
 * Check whether the process at PID has argv containing the expected token.
 * Used to defend against PID-reuse before destructive kill operations.
 *
 * @param pid - target process id
 * @param expectedToken - token expected somewhere in argv (e.g. a basename like 'watchdog-entry')
 * @returns true if process exists AND argv contains the token; false otherwise
 *          (process gone, perm denied, ps failed, token absent — all conservative)
 */
export function isPidArgvMatching(pid: number, expectedToken: string): boolean {
  const argv = readPidArgv(pid);
  if (!argv) return false;
  return argv.includes(expectedToken);
}
