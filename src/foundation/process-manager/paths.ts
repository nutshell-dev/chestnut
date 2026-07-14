import * as path from 'path';
import type { DaemonDir } from './types.js';
import type { ProcessManagerContext } from './types.js';


export const STATUS_SUBDIR = 'status';

export function getStatusDir(_ctx: ProcessManagerContext, daemonDir: DaemonDir): string {
  return path.join(daemonDir, STATUS_SUBDIR);
}

export function getPidFile(ctx: ProcessManagerContext, daemonDir: DaemonDir): string {
  return path.join(getStatusDir(ctx, daemonDir), 'pid');
}

export function getLockFile(ctx: ProcessManagerContext, daemonDir: DaemonDir): string {
  return path.join(getStatusDir(ctx, daemonDir), 'daemon.lock');
}

// phase 1017: spawn-transition 专用锁（覆盖 {pid:0} → {pid:real} 窗口），
// 与 daemon 生命周期锁（daemon.lock）独立，避免 spawn 与子进程 assemble 争用同一把锁
export function getSpawnLockFile(ctx: ProcessManagerContext, daemonDir: DaemonDir): string {
  return path.join(getStatusDir(ctx, daemonDir), 'daemon.lock.spawn');
}

export function getReadyFile(ctx: ProcessManagerContext, daemonDir: DaemonDir): string {
  return path.join(getStatusDir(ctx, daemonDir), 'ready');
}

export async function ensureStatusDir(ctx: ProcessManagerContext, daemonDir: DaemonDir): Promise<void> {
  await ctx.fs.ensureDir(getStatusDir(ctx, daemonDir));
}
