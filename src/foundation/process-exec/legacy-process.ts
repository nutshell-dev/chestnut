/**
 * @module L1.ProcessExec
 *
 * Legacy single-process compatibility path (phase 1269 Step E).
 *
 * Pre-phase-1269 migrated exec tasks persisted only `migratedPid` /
 * `migratedStartTime`. Those processes were spawned non-detached and are NOT
 * process-group leaders, so a PGID must never be guessed from the PID: group
 * signalling could hit an innocent reused group. This module is the explicit
 * L1 compatibility path for those tasks: PID + start-time ownership
 * verification and a bounded single-process TERM→grace→KILL→confirm
 * termination state machine.
 *
 * Descendant cleanup is NOT provable on this path (the process tree was not
 * tracked); callers must audit that limitation honestly. New writes use the
 * execution-group protocol (execution-group.ts); this path exists only until
 * legacy in-flight tasks drain naturally.
 */

import {
  PROCESS_EXEC_SIGKILL_GRACE_MS,
  PROCESS_EXEC_GROUP_KILL_CONFIRM_MS,
  PROCESS_EXEC_GROUP_CONFIRM_POLL_MS,
} from './constants.js';
import { isAlive } from './process-control.js';
import { getProcessStartTime } from './process-starttime.js';
import type { GroupTerminationOptions } from './execution-group.js';

/**
 * Recovery probe result for a legacy PID-only identity.
 * - alive: leader PID alive and (when provided) start time matches → the
 *   caller may terminate THIS PROCESS ONLY via terminateLegacyProcess().
 * - gone: PID dead or provably reused by a different process (start time
 *   mismatch) → the original process is gone; NEVER signal the reused PID.
 * - indeterminate: ownership cannot be verified (start time unreadable).
 */
type LegacyProcessRecoveryState =
  | { kind: 'alive' }
  | { kind: 'gone' }
  | { kind: 'indeterminate'; reason: string };

/**
 * Probe whether a legacy persisted PID still refers to the original process.
 * Pure probe — never signals.
 * Conservative alignment (phase 1271): a missing start time yields
 * indeterminate, never alive — without ownership evidence a reused PID would
 * otherwise be signalled.
 */
export function probeLegacyProcess(
  pid: number,
  expectedStartTime?: string,
): LegacyProcessRecoveryState {
  if (!isAlive(pid)) return { kind: 'gone' };
  // Conservative alignment with execution-group probes: a missing start time
  // cannot distinguish the original process from a reused PID — never report
  // alive without ownership evidence. Legacy tasks with a missing start time
  // follow the indeterminate path (L4 deadline fallback notification).
  if (expectedStartTime === undefined) {
    return { kind: 'indeterminate', reason: 'start_time_unavailable' };
  }
  const actual = getProcessStartTime(pid);
  if (actual === undefined) return { kind: 'indeterminate', reason: 'start_time_unreadable' };
  if (actual !== expectedStartTime) return { kind: 'gone' }; // PID reused — original is gone
  return { kind: 'alive' };
}

/**
 * Termination outcome for the legacy single-process state machine. Mirrors
 * the ExecutionTerminationOutcome three-state honesty contract: `gone` is
 * only reported after positive confirmation, `indeterminate` carries a
 * reason and must never be flattened to gone.
 */
export type LegacyProcessTerminationOutcome =
  | { status: 'gone'; pid: number; termSent: boolean; killSent: boolean; completedAt: string }
  | { status: 'still_alive'; pid: number; termSent: boolean; killSent: boolean; checkedAt: string }
  | { status: 'indeterminate'; pid: number; termSent: boolean; killSent: boolean; checkedAt: string; reason: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded wait for the PID to disappear. */
async function waitProcessGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(PROCESS_EXEC_GROUP_CONFIRM_POLL_MS);
  }
}

function goneOutcome(pid: number, termSent: boolean, killSent: boolean): LegacyProcessTerminationOutcome {
  return { status: 'gone', pid, termSent, killSent, completedAt: new Date().toISOString() };
}

function indeterminateOutcome(
  pid: number,
  termSent: boolean,
  killSent: boolean,
  reason: string,
): LegacyProcessTerminationOutcome {
  return { status: 'indeterminate', pid, termSent, killSent, checkedAt: new Date().toISOString(), reason };
}

/**
 * Run the bounded termination state machine for ONE legacy process:
 * ownership re-verify → TERM → grace (early-confirmed) → KILL → bounded
 * confirm. Ownership is re-verified immediately before signalling so a
 * reused PID is never signalled. Descendants are out of scope by design —
 * the legacy spawn was non-detached and the tree was never tracked.
 */
export async function terminateLegacyProcess(
  pid: number,
  expectedStartTime?: string,
  options?: GroupTerminationOptions,
): Promise<LegacyProcessTerminationOutcome> {
  const graceMs = options?.graceMs ?? PROCESS_EXEC_SIGKILL_GRACE_MS;
  const confirmMs = options?.confirmMs ?? PROCESS_EXEC_GROUP_KILL_CONFIRM_MS;
  let termSent = false;
  let killSent = false;

  // 1. Re-verify ownership right before signalling — never signal a reused PID.
  const probe = probeLegacyProcess(pid, expectedStartTime);
  if (probe.kind === 'gone') return goneOutcome(pid, termSent, killSent);
  if (probe.kind === 'indeterminate') {
    return indeterminateOutcome(pid, termSent, killSent, probe.reason);
  }

  // 2. SIGTERM (single process, positive PID only).
  try {
    process.kill(pid, 'SIGTERM');
    termSent = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      return goneOutcome(pid, termSent, killSent);
    }
    return indeterminateOutcome(pid, termSent, killSent, 'sigterm_send_failed'); // EPERM etc. ≠ gone
  }

  // 3. TERM grace with early confirmation.
  if (await waitProcessGone(pid, graceMs)) {
    return goneOutcome(pid, termSent, killSent);
  }

  // 4. SIGKILL.
  try {
    process.kill(pid, 'SIGKILL');
    killSent = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      return goneOutcome(pid, termSent, killSent);
    }
    return indeterminateOutcome(pid, termSent, killSent, 'sigkill_send_failed');
  }

  // 5. Bounded post-KILL confirmation.
  if (await waitProcessGone(pid, confirmMs)) {
    return goneOutcome(pid, termSent, killSent);
  }

  // 6. Still responding after SIGKILL. If the start time now mismatches, the
  //    original died and the PID was reused — the original is gone.
  if (expectedStartTime !== undefined) {
    const actual = getProcessStartTime(pid);
    if (actual !== undefined && actual !== expectedStartTime) {
      return goneOutcome(pid, termSent, killSent);
    }
  }

  return { status: 'still_alive', pid, termSent, killSent, checkedAt: new Date().toISOString() };
}
