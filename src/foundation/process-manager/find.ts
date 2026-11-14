import {
  findByLiteralPatternSyncForCli,
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

function listProcessesSyncForCli(ctx: ProcessManagerContext, pattern: string): ProcessInfo[] {
  try {
    return findByLiteralPatternSyncForCli(pattern);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) auditListFailure(ctx, pattern, err);
    throw err;
  }
}

/** Synchronous diagnostic query restricted to explicit CLI call sites. */
export function findProcessesSyncForCli(ctx: ProcessManagerContext, pattern: string): number[] {
  return listProcessesSyncForCli(ctx, pattern)
    .map(item => item.pid)
    .filter(pid => pid !== process.pid);
}

async function listProcessesAsync(
  ctx: ProcessManagerContext,
  pattern: string,
  options: FindByPatternOptions,
): Promise<ProcessInfo[]> {
  try {
    const processes = await findByLiteralPatternAsync(pattern, options);
    return processes.filter(item => item.pid !== process.pid);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) auditListFailure(ctx, pattern, err);
    throw err;
  }
}

/** Bounded async PID query for event-loop-sensitive production callers. */
export async function findProcessesAsync(
  ctx: ProcessManagerContext,
  pattern: string,
  options: FindByPatternOptions = {},
): Promise<number[]> {
  return (await listProcessesAsync(ctx, pattern, options)).map(item => item.pid);
}

/** Bounded async detailed query for event-loop-sensitive orphan cleanup. */
export async function findProcessesDetailedAsync(
  ctx: ProcessManagerContext,
  pattern: string,
  options: FindByPatternOptions = {},
): Promise<ProcessInfo[]> {
  return listProcessesAsync(ctx, pattern, options);
}
