import { spawn, spawnSync } from 'child_process';
import { openSync, closeSync } from 'fs';
import { ProcessListUnavailable } from './errors.js';
import type { SpawnDetachedOptions } from './types.js';

/**
 * Spawn a long-running detached process (typically daemon).
 *
 * Encapsulates child_process.spawn + log fd management.
 * - detached: true / unref: true (daemon 独立 parent 生命周期)
 * - logFile: 内部 openSync 拿 fd / spawn 后 closeSync (child 已 inherit fd)
 *
 * @returns { pid } - spawned process id
 * @throws Error if spawn returns no pid (rare / EAGAIN etc)
 */
export function spawnDetached(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnDetachedOptions,
): { pid: number } {
  const logFd = options.logFile ? openSync(options.logFile, 'a') : 'ignore';
  try {
    const proc = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    if (!proc.pid) {
      throw new Error('spawnDetached: failed to spawn process (no pid)');
    }
    proc.unref();
    return { pid: proc.pid };
  } finally {
    if (typeof logFd === 'number') closeSync(logFd);
  }
}

/**
 * Find processes by pattern using pgrep (POSIX).
 *
 * @returns array of pids matching pattern (empty if no match)
 * @throws ProcessListUnavailable if pgrep binary not available
 */
export function pgrepSync(pattern: string): number[] {
  try {
    const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf-8' });
    if (result.error) {
      throw new ProcessListUnavailable(pattern, result.error);
    }
    if (result.status === 1) {
      return [];  // pgrep returns 1 when no match (not error)
    }
    if (result.status !== 0) {
      throw new ProcessListUnavailable(pattern, new Error(`pgrep exit ${result.status}`));
    }
    return result.stdout
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => parseInt(s, 10))
      .filter(n => !isNaN(n));
  } catch (err) {
    if (err instanceof ProcessListUnavailable) throw err;
    throw new ProcessListUnavailable(pattern, err);
  }
}
