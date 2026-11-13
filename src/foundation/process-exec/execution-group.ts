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
import { encodeProcessEvidence, type ProcessEvidence } from './process-evidence.js';
import { observeProcess } from './process-observation.js';
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

/** Guard against signalling the host/init process group. */
function isGroupSignalSafe(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (pgid === process.pid || pgid === process.ppid) return false;
  return true;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined;
}

type GroupPresence =
  | { kind: 'alive' }
  | { kind: 'gone' }
  | { kind: 'unknown'; error: unknown };

function probeProcessGroup(pgid: number): GroupPresence {
  if (!isGroupSignalSafe(pgid)) {
    return { kind: 'unknown', error: new Error(`unsafe process group id: ${pgid}`) };
  }
  try {
    process.kill(-pgid, 0);
    return { kind: 'alive' };
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return { kind: 'gone' };
    return { kind: 'unknown', error };
  }
}

/** Compatibility boolean probe; errors remain non-gone. */
export function isProcessGroupAlive(pgid: number): boolean {
  return probeProcessGroup(pgid).kind !== 'gone';
}

type GroupSignalResult =
  | { kind: 'sent' }
  | { kind: 'gone' }
  | { kind: 'error'; error: unknown };

function signalProcessGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): GroupSignalResult {
  if (!isGroupSignalSafe(pgid)) {
    return { kind: 'error', error: new Error(`unsafe process group id: ${pgid}`) };
  }
  try {
    process.kill(-pgid, signal);
    return { kind: 'sent' };
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return { kind: 'gone' };
    return { kind: 'error', error };
  }
}

type ExecutionGroupRecoveryState =
  | { kind: 'verified_alive' }
  | { kind: 'gone' }
  | { kind: 'indeterminate'; reason: string };

export interface ExecutionGroupProbeDetail {
  state: ExecutionGroupRecoveryState;
  evidence: ProcessEvidence;
  error?: unknown;
}

/**
 * Creation invariant of v1 identities. Validation belongs to ProcessExec, not
 * to the AsyncTaskSystem persistence schema.
 */
export function isValidV1ExecutionIdentity(identity: ExecutionIdentity): boolean {
  const { leaderPid, processGroupId } = identity;
  return (
    Number.isSafeInteger(leaderPid) &&
    Number.isSafeInteger(processGroupId) &&
    leaderPid > 1 &&
    processGroupId > 1 &&
    leaderPid === processGroupId
  );
}

function groupAbsentOrUnknown(
  identity: ExecutionIdentity,
  facts: unknown[],
  reused: boolean,
): { state: ExecutionGroupRecoveryState; error?: unknown } {
  const group = probeProcessGroup(identity.processGroupId);
  facts.push({ operation: 'group_signal0', outcome: group.kind, pgid: identity.processGroupId,
    ...(group.kind === 'unknown' ? { error: group.error } : {}) });
  if (group.kind === 'gone') return { state: { kind: 'gone' } };
  if (group.kind === 'unknown') {
    return { state: { kind: 'indeterminate', reason: 'group_probe_failed' }, error: group.error };
  }
  return {
    state: {
      kind: 'indeterminate',
      reason: reused ? 'leader_reused_group_alive' : 'leader_gone_group_alive',
    },
  };
}

/** Detailed recovery probe used by the typed execution-target facade. */
export function probeExecutionGroupDetailed(
  identity: ExecutionIdentity,
  leaderStartTime?: string,
): ExecutionGroupProbeDetail {
  const atMs = Date.now();
  const facts: unknown[] = [{ operation: 'observe_execution_group', outcome: 'start', identity }];
  const finish = (result: { state: ExecutionGroupRecoveryState; error?: unknown }): ExecutionGroupProbeDetail => ({
    state: result.state,
    evidence: encodeProcessEvidence(atMs, facts),
    ...(result.error !== undefined ? { error: result.error } : {}),
  });

  if (!isValidV1ExecutionIdentity(identity)) {
    return finish({ state: { kind: 'indeterminate', reason: 'invalid_execution_identity' } });
  }

  const leader = observeProcess(identity.leaderPid);
  facts.push({ operation: 'observe_leader', outcome: leader });
  if (leader.kind === 'gone') return finish(groupAbsentOrUnknown(identity, facts, false));
  if (leader.kind === 'unknown') {
    return finish({ state: { kind: 'indeterminate', reason: 'leader_start_time_unreadable' } });
  }
  if (leaderStartTime === undefined) {
    return finish({ state: { kind: 'indeterminate', reason: 'leader_start_time_unavailable' } });
  }
  if (leader.startTime !== leaderStartTime) {
    return finish(groupAbsentOrUnknown(identity, facts, true));
  }
  return finish({ state: { kind: 'verified_alive' } });
}

/** Backward-compatible compact probe; typed callers use observeExecutionTarget. */
export function probeExecutionGroup(
  identity: ExecutionIdentity,
  leaderStartTime?: string,
): ExecutionGroupRecoveryState {
  return probeExecutionGroupDetailed(identity, leaderStartTime).state;
}

type WithoutEvidence<T> = T extends unknown ? Omit<T, 'evidence'> : never;

function finishTermination(
  atMs: number,
  facts: unknown[],
  outcome: WithoutEvidence<ExecutionTerminationOutcome>,
): ExecutionTerminationOutcome {
  return { ...outcome, evidence: encodeProcessEvidence(atMs, facts) } as ExecutionTerminationOutcome;
}

function goneOutcome(
  atMs: number,
  facts: unknown[],
  identity: ExecutionIdentity,
  trigger: ExecutionTerminationTrigger,
  termSent: boolean,
  killSent: boolean,
): ExecutionTerminationOutcome {
  return finishTermination(atMs, facts, {
    status: 'gone', identity, trigger, termSent, killSent,
    completedAt: new Date().toISOString(),
  });
}

function indeterminateOutcome(
  atMs: number,
  facts: unknown[],
  identity: ExecutionIdentity,
  trigger: ExecutionTerminationTrigger,
  termSent: boolean,
  killSent: boolean,
  reason: string,
): ExecutionTerminationOutcome {
  return finishTermination(atMs, facts, {
    status: 'indeterminate', identity, trigger, termSent, killSent,
    checkedAt: new Date().toISOString(), reason,
  });
}

async function waitGroupGone(
  pgid: number,
  budgetMs: number,
  facts: unknown[],
): Promise<GroupPresence> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const group = probeProcessGroup(pgid);
    facts.push({ operation: 'group_signal0', outcome: group.kind, pgid,
      ...(group.kind === 'unknown' ? { error: group.error } : {}) });
    if (group.kind === 'gone') return group;
    // Unknown (including transient EPERM during leader teardown) may become a
    // provable absence within the existing bounded observation window. Retry
    // without signalling; never escalate merely because a probe was unknown.
    if (Date.now() >= deadline) return group;
    await delay(PROCESS_EXEC_GROUP_CONFIRM_POLL_MS);
  }
}

/**
 * TERM group → grace → KILL group → bounded confirmation. Unknown observation
 * never authorizes escalation and is never reported as gone. Signal errors and
 * every confirmation observation remain in the returned evidence.
 */
export async function terminateExecutionGroup(
  identity: ExecutionIdentity,
  trigger: ExecutionTerminationTrigger,
  options?: GroupTerminationOptions,
): Promise<ExecutionTerminationOutcome> {
  const atMs = Date.now();
  const facts: unknown[] = [{ operation: 'terminate_execution_group', outcome: 'start', identity, trigger }];
  const pgid = identity.processGroupId;
  const graceMs = options?.graceMs ?? PROCESS_EXEC_SIGKILL_GRACE_MS;
  const confirmMs = options?.confirmMs ?? PROCESS_EXEC_GROUP_KILL_CONFIRM_MS;
  let termSent = false;
  let killSent = false;

  if (!isValidV1ExecutionIdentity(identity)) {
    return indeterminateOutcome(atMs, facts, identity, trigger, termSent, killSent, 'invalid_execution_identity');
  }
  if (!isGroupSignalSafe(pgid)) {
    return indeterminateOutcome(atMs, facts, identity, trigger, termSent, killSent, 'unsafe_process_group_id');
  }

  const termResult = signalProcessGroup(pgid, 'SIGTERM');
  facts.push({ operation: 'signal', signal: 'SIGTERM', outcome: termResult.kind, pgid,
    ...(termResult.kind === 'error' ? { error: termResult.error } : {}) });
  termSent = termResult.kind === 'sent';
  if (termResult.kind === 'gone') return goneOutcome(atMs, facts, identity, trigger, termSent, killSent);
  if (termResult.kind === 'error') {
    return indeterminateOutcome(atMs, facts, identity, trigger, termSent, killSent, 'sigterm_send_failed');
  }

  const afterTerm = await waitGroupGone(pgid, graceMs, facts);
  if (afterTerm.kind === 'gone') return goneOutcome(atMs, facts, identity, trigger, termSent, killSent);
  if (afterTerm.kind === 'unknown') {
    return indeterminateOutcome(atMs, facts, identity, trigger, termSent, killSent, 'group_probe_failed');
  }

  const killResult = signalProcessGroup(pgid, 'SIGKILL');
  facts.push({ operation: 'signal', signal: 'SIGKILL', outcome: killResult.kind, pgid,
    ...(killResult.kind === 'error' ? { error: killResult.error } : {}) });
  killSent = killResult.kind === 'sent';
  if (killResult.kind === 'gone') return goneOutcome(atMs, facts, identity, trigger, termSent, killSent);

  const afterKill = await waitGroupGone(pgid, confirmMs, facts);
  if (afterKill.kind === 'gone') return goneOutcome(atMs, facts, identity, trigger, termSent, killSent);
  if (killResult.kind === 'error') {
    return indeterminateOutcome(atMs, facts, identity, trigger, termSent, killSent, 'sigkill_send_failed');
  }
  if (afterKill.kind === 'unknown') {
    return indeterminateOutcome(atMs, facts, identity, trigger, termSent, killSent, 'group_probe_failed');
  }

  return finishTermination(atMs, facts, {
    status: 'still_alive', identity, trigger, termSent, killSent,
    checkedAt: new Date().toISOString(),
  });
}
