/**
 * Abort signal handling utilities for the React loop.
 */

import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../types/signals.js';

export function throwAbortError(signal: AbortSignal): never {
  const r = signal.reason as { type?: string; ms?: number } | undefined;
  if (r?.type === 'idle_timeout') throw new IdleTimeoutSignal(r.ms ?? 0);
  if (r?.type === 'step_yield')   throw new PriorityInboxInterrupt();
  if (r?.type === 'user')         throw new UserInterrupt();
  throw new Error(`Execution aborted (unexpected reason: ${JSON.stringify(r)})`);
}
