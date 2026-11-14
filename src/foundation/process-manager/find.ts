import {
  findByLiteralPattern,
  findByLiteralPatternAsync,
  ProcessListUnavailable,
  type FindByPatternOptions,
  type ProcessInfo,
} from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import type { ProcessManagerContext } from './types.js';

function auditListFailure(
  ctx: ProcessManagerContext,
  pattern: string,
  err: ProcessListUnavailable,
): void {
  const cause = err.cause instanceof Error
    ? {
        name: err.cause.name,
        message: err.cause.message,
        code: (err.cause as NodeJS.ErrnoException).code ?? null,
      }
    : String(err.cause);
  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_LIST_FAILED,
    `pattern=${pattern}`,
    `reason=${err.message}`,
    `evidence=${JSON.stringify({
      ...err.evidence,
      code: err.evidence.code ?? null,
      errorCode: err.code,
      cause,
    })}`,
  );
}

function listProcesses(ctx: ProcessManagerContext, pattern: string): ProcessInfo[] {
  try {
    return findByLiteralPattern(pattern);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) auditListFailure(ctx, pattern, err);
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

/** Bounded async detailed query for event-loop-sensitive orphan cleanup. */
export async function findProcessesDetailedAsync(
  ctx: ProcessManagerContext,
  pattern: string,
  options: FindByPatternOptions = {},
): Promise<ProcessInfo[]> {
  try {
    const processes = await findByLiteralPatternAsync(pattern, options);
    return processes.filter(item => item.pid !== process.pid);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) auditListFailure(ctx, pattern, err);
    throw err;
  }
}
