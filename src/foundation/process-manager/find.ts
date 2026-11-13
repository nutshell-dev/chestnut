import {
  findByLiteralPattern,
  ProcessListUnavailable,
  type ProcessInfo,
} from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import type { ProcessManagerContext } from './types.js';

function listProcesses(ctx: ProcessManagerContext, pattern: string): ProcessInfo[] {
  try {
    return findByLiteralPattern(pattern);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) {
      ctx.audit.write(
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_LIST_FAILED,
        `pattern=${pattern}`,
        `reason=${err.message}`,
      );
    }
    throw err;
  }
}

/** Legacy public query: literal matching and OS decoding remain in ProcessExec. */
export function findProcesses(ctx: ProcessManagerContext, pattern: string): number[] {
  return listProcesses(ctx, pattern)
    .map(item => item.pid)
    .filter(pid => pid !== process.pid);
}

/** L1 listing evidence for the L1 orphan-termination capability. */
export function findProcessesDetailed(ctx: ProcessManagerContext, pattern: string): ProcessInfo[] {
  return listProcesses(ctx, pattern).filter(item => item.pid !== process.pid);
}
