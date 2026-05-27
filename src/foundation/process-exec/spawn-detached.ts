import { spawn } from 'child_process';
import { openSync, closeSync } from 'fs';
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
