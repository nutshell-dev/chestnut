/**
 * Abort signal handling utilities for the React loop.
 */

import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from './signals.js';
import { STEP_EXECUTOR_AUDIT_EVENTS } from './audit-events.js';

export function throwAbortError(signal: AbortSignal, auditWriter?: { write: (...args: string[]) => void }): never {
  const r = signal.reason as { type?: string; ms?: number } | undefined;
  if (r?.type === 'idle_timeout') throw new IdleTimeoutSignal(r.ms ?? 0);
  if (r?.type === 'step_yield')   throw new PriorityInboxInterrupt();
  if (r?.type === 'user')         throw new UserInterrupt();
  const violationMsg = `Execution aborted (unexpected reason: ${JSON.stringify(r)})`;
  auditWriter?.write(
    STEP_EXECUTOR_AUDIT_EVENTS.INVARIANT_VIOLATION,
    `site=abort-helpers.ts:12`,
    `kind=unexpected_abort_reason`,
    `reason=${JSON.stringify(r)}`,
    `msg=${violationMsg}`,
  );
  throw new Error(`[INVARIANT VIOLATION] step-executor: ${violationMsg}`);
}
