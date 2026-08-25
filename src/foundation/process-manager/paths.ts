import * as path from 'path';
import type { DaemonDir } from './types.js';
import type { ProcessManagerContext } from './types.js';


export const STATUS_SUBDIR = 'status';

export function getStatusDir(_ctx: ProcessManagerContext, daemonDir: DaemonDir): string {
  return path.join(daemonDir, STATUS_SUBDIR);
}
