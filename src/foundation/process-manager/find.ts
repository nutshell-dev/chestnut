import { findByPattern } from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { ProcessListUnavailable } from './errors.js';
import type { ProcessManagerContext } from './types.js';

export function findProcesses(ctx: ProcessManagerContext, pattern: string): number[] {
  const escaped = pattern.replace(/[\\.^$*+?()[\]{}|]/g, '\\$&');
  let pids: number[];
  try {
    pids = findByPattern(escaped).map(p => p.pid);
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
  return pids.filter(p => p !== process.pid);
}
