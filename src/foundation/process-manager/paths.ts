import * as path from 'path';
import type { ProcessManagerContext } from './types.js';

export const STATUS_SUBDIR = 'status';

export function getStatusDir(ctx: ProcessManagerContext, clawId: string): string {
  return path.join(ctx.resolveDir(clawId), STATUS_SUBDIR);
}

export function getPidFile(ctx: ProcessManagerContext, clawId: string): string {
  return path.join(getStatusDir(ctx, clawId), 'pid');
}

export function getLockFile(ctx: ProcessManagerContext, clawId: string): string {
  return path.join(getStatusDir(ctx, clawId), 'daemon.lock');
}

export function getReadyFile(ctx: ProcessManagerContext, clawId: string): string {
  return path.join(getStatusDir(ctx, clawId), 'ready');
}

export async function ensureStatusDir(ctx: ProcessManagerContext, clawId: string): Promise<void> {
  await ctx.fs.ensureDir(getStatusDir(ctx, clawId));
}
