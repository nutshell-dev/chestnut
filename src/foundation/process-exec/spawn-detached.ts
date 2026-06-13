import { spawn } from 'child_process';
import { openSync, closeSync } from 'fs';
import type { SpawnDetachedOptions } from './types.js';
import { scrubEnv } from './env-scrub.js';

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
    // phase 346 B1 (review-2026-06-13): 始终 scrub env 到 allowlist，
    // 避免 wholesale inherit parent's process.env 把 ssh-agent socket /
    // 任意 user-set 环境变量 / 别的 secret 灌入 detached 子进程。
    // caller 显式 options.env 仍走 scrub（caller 多半 spread process.env、
    // 真正想加的几 key 落 allowlist 内、scrub 不掉）。
    const rawEnv = options.env ?? process.env;
    const scrubbedEnv = scrubEnv(rawEnv as NodeJS.ProcessEnv);
    const proc = spawn(command, [...args], {
      cwd: options.cwd,
      env: scrubbedEnv,
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
