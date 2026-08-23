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
import { isAlive } from './process-control.js';
import { getProcessStartTime } from './process-starttime.js';
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
 * Recovery probe result for a persisted execution identity (restart path).
 * L4 maps these states to task state; it never performs its own OS probes or
 * signals. `indeterminate` is a safety requirement, not an unfinished
 * implementation: POSIX offers no durable process-group creation time, so a
 * responding PGID without a verified leader cannot be distinguished from
 * PGID reuse — signalling it could kill an innocent reused group.
 */
export type ExecutionGroupRecoveryState =
  | { kind: 'verified_alive' }
  | { kind: 'gone' }
  | { kind: 'indeterminate'; reason: string };

/**
 * Creation invariant of the v1 execution identity (phase 1269 Step F).
 *
 * `execWithHandle` is the ONLY creator of v1 identities and always spawns
 * with `detached: true`, so at creation the leader IS its process group
 * (PGID === leader PID). A POSIX session/group leader cannot migrate into
 * another process group while alive. Therefore a live leader whose start
 * time matches, on an identity satisfying this invariant, is provably the
 * original detached leader — no second OS PGID query is needed (and Node
 * v20 exposes none).
 *
 * Identities violating the invariant are NOT v1 identities: never verify
 * them, never signal them.
 */
function isValidV1ExecutionIdentity(identity: ExecutionIdentity): boolean {
  const { leaderPid, processGroupId } = identity;
  return (
    Number.isSafeInteger(leaderPid) &&
    Number.isSafeInteger(processGroupId) &&
    leaderPid > 1 &&
    processGroupId > 1 &&
    leaderPid === processGroupId
  );
}

/**
 * Probe whether a persisted execution identity still refers to a provably
 * owned execution unit. Pure probe — never signals.
 *
 * - verified_alive: identity satisfies the v1 creation invariant, leader
 *   alive, start time matches → the caller may terminate the group via
 *   terminateExecutionGroup().
 * - gone: leader dead (or provably reused) AND the group no longer responds.
 * - indeterminate: ownership cannot be proven (identity violates the
 *   creation invariant, leader gone but group still responds,
 *   unreadable/missing start time).
 */
export function probeExecutionGroup(
  identity: ExecutionIdentity,
  leaderStartTime?: string,
): ExecutionGroupRecoveryState {
  if (!isValidV1ExecutionIdentity(identity)) {
    return { kind: 'indeterminate', reason: 'invalid_execution_identity' };
  }

  const leaderAlive = isAlive(identity.leaderPid);
  if (!leaderAlive) {
    return isProcessGroupAlive(identity.processGroupId)
      ? { kind: 'indeterminate', reason: 'leader_gone_group_alive' }
      : { kind: 'gone' };
  }

  if (leaderStartTime === undefined) {
    return { kind: 'indeterminate', reason: 'leader_start_time_unavailable' };
  }
  const actualStartTime = getProcessStartTime(identity.leaderPid);
  if (actualStartTime === undefined) {
    return { kind: 'indeterminate', reason: 'leader_start_time_unreadable' };
  }
  if (actualStartTime !== leaderStartTime) {
    // Leader PID provably reused — the original leader is gone. Only the
    // group response decides whether anything attributable may remain.
    return isProcessGroupAlive(identity.processGroupId)
      ? { kind: 'indeterminate', reason: 'leader_reused_group_alive' }
      : { kind: 'gone' };
  }

  // Leader alive with matching start time on a valid v1 identity: by the
  // creation invariant the live leader is still the original detached
  // session/group leader. verified without any additional OS query.
  return { kind: 'verified_alive' };
}

/**
 * Run the termination state machine for one execution group:
 * TERM group → grace (early-confirmed when the group exits cooperatively) →
 * if still alive, KILL group → bounded poll until the group is gone or the
 * confirm budget is exhausted.
 *
 * Known TOCTOU (accepted trade-off, phase 1271 F8): between a verified_alive
 * probe and the TERM signal below, the leader may exit and the PGID be
 * reused by an unrelated group. POSIX provides no durable process-group
 * creation time, so this window cannot be closed — signalling during it may
 * hit an innocent reused group. The window is microseconds (probe and
 * signal are adjacent calls); recovery re-probes every cycle, and the
 * indeterminate state above already refuses to signal when ownership cannot
 * be proven.
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

  // Runtime guard independent of the disk schema (phase 1269 Step F): only
  // identities satisfying the v1 creation invariant may be signalled.
  if (!isValidV1ExecutionIdentity(identity)) {
    return indeterminateOutcome(identity, trigger, termSent, killSent, 'invalid_execution_identity');
  }

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

  if (await waitGroupGone(pgid, confirmMs)) {
    return goneOutcome(identity, trigger, termSent, killSent);
  }

  if (killResult === 'error') {
    return indeterminateOutcome(identity, trigger, termSent, killSent, 'sigkill_send_failed');
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
