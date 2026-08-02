/**
 * @module L1.ProcessExec
 *
 * Execution-group primitives (L1-internal): POSIX process-group signalling,
 * liveness probe, and the single idempotent TERM→grace→KILL→confirm
 * termination state machine.
 *
 * Only this module may emit negative-PGID (process-group) signals. Negative
 * PGID signal details must not leak across module boundaries: callers pass an
 * `ExecutionIdentity` and receive an `ExecutionTerminationOutcome`.
 *
 * POSIX-only, same decision as process-control.ts.
 */

import {
  PROCESS_EXEC_SIGKILL_GRACE_MS,
  PROCESS_EXEC_GROUP_KILL_CONFIRM_MS,
  PROCESS_EXEC_GROUP_CONFIRM_POLL_MS,
} from './constants.js';
import type {
  ExecutionIdentity,
  ExecutionTerminationOutcome,
  ExecutionTerminationTrigger,
} from './types.js';

export interface GroupTerminationOptions {
  /** TERM→KILL grace. Defaults to PROCESS_EXEC_SIGKILL_GRACE_MS. */
  graceMs?: number;
  /** Post-KILL bounded confirmation budget. Defaults to PROCESS_EXEC_GROUP_KILL_CONFIRM_MS. */
  confirmMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded wait for the group to disappear, polling at
 * PROCESS_EXEC_GROUP_CONFIRM_POLL_MS. Returns true as soon as the group is
 * gone; false when the budget is exhausted with members still present.
 */
async function waitGroupGone(pgid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!isProcessGroupAlive(pgid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(PROCESS_EXEC_GROUP_CONFIRM_POLL_MS);
  }
}

/**
 * Guard against catastrophic mis-aiming of a group signal: never target the
 * caller's own process group (would kill the host process / test runner) or
 * init's group. Returns true when the PGID is safe to signal.
 */
function isGroupSignalSafe(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (pgid === process.pid || pgid === process.ppid) return false;
  return true;
}

/**
 * Probe whether any member of the process group still exists.
 * ESRCH = gone; EPERM = exists but not signal-able by us (NOT gone);
 * unknown errors are treated as alive (never flatten to gone).
 */
export function isProcessGroupAlive(pgid: number): boolean {
  if (!isGroupSignalSafe(pgid)) return true;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

type GroupSignalResult = 'sent' | 'gone' | 'error';

function signalProcessGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): GroupSignalResult {
  if (!isGroupSignalSafe(pgid)) return 'error';
  try {
    process.kill(-pgid, signal);
    return 'sent';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
    return 'error'; // EPERM etc. must never be read as gone
  }
}

function goneOutcome(
  identity: ExecutionIdentity,
  trigger: ExecutionTerminationTrigger,
  termSent: boolean,
  killSent: boolean,
): ExecutionTerminationOutcome {
  return {
    status: 'gone',
    identity,
    trigger,
    termSent,
    killSent,
    completedAt: new Date().toISOString(),
  };
}

function indeterminateOutcome(
  identity: ExecutionIdentity,
  trigger: ExecutionTerminationTrigger,
  termSent: boolean,
  killSent: boolean,
  reason: string,
): ExecutionTerminationOutcome {
  return {
    status: 'indeterminate',
    identity,
    trigger,
    termSent,
    killSent,
    checkedAt: new Date().toISOString(),
    reason,
  };
}

/**
 * Run the termination state machine for one execution group:
 * TERM group → grace (early-confirmed when the group exits cooperatively) →
 * if still alive, KILL group → bounded poll until the group is gone or the
 * confirm budget is exhausted.
 *
 * This function is NOT itself idempotent; idempotent coordination (first
 * trigger wins, earliest deadline fixed, shared in-flight promise) is owned
 * by the ExecHandle in exec.ts. Recovery callers hold their own single-entry
 * discipline (L4 running-task file is the single source of truth).
 */
export async function terminateExecutionGroup(
  identity: ExecutionIdentity,
  trigger: ExecutionTerminationTrigger,
  options?: GroupTerminationOptions,
): Promise<ExecutionTerminationOutcome> {
  const pgid = identity.processGroupId;
  const graceMs = options?.graceMs ?? PROCESS_EXEC_SIGKILL_GRACE_MS;
  const confirmMs = options?.confirmMs ?? PROCESS_EXEC_GROUP_KILL_CONFIRM_MS;
  let termSent = false;
  let killSent = false;

  if (!isGroupSignalSafe(pgid)) {
    return indeterminateOutcome(identity, trigger, termSent, killSent, 'unsafe_process_group_id');
  }

  const termResult = signalProcessGroup(pgid, 'SIGTERM');
  termSent = termResult === 'sent';
  if (termResult === 'gone') return goneOutcome(identity, trigger, termSent, killSent);
  if (termResult === 'error') {
    return indeterminateOutcome(identity, trigger, termSent, killSent, 'sigterm_send_failed');
  }

  // TERM grace: give the group the full grace window to exit gracefully,
  // but confirm early when it does — a cooperative termination must not
  // stall callers for the whole grace.
  if (await waitGroupGone(pgid, graceMs)) {
    return goneOutcome(identity, trigger, termSent, killSent);
  }

  const killResult = signalProcessGroup(pgid, 'SIGKILL');
  killSent = killResult === 'sent';
  if (killResult === 'gone') return goneOutcome(identity, trigger, termSent, killSent);
  if (killResult === 'error') {
    return indeterminateOutcome(identity, trigger, termSent, killSent, 'sigkill_send_failed');
  }

  if (await waitGroupGone(pgid, confirmMs)) {
    return goneOutcome(identity, trigger, termSent, killSent);
  }

  return {
    status: 'still_alive',
    identity,
    trigger,
    termSent,
    killSent,
    checkedAt: new Date().toISOString(),
  };
}
