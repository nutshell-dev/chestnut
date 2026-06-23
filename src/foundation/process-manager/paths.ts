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

export function getReadyFile(ctx: ProcessManagerContext, daemonDir: DaemonDir): string {
  return path.join(getStatusDir(ctx, daemonDir), 'ready');
}

export async function ensureStatusDir(ctx: ProcessManagerContext, daemonDir: DaemonDir): Promise<void> {
  await ctx.fs.ensureDir(getStatusDir(ctx, daemonDir));
}
