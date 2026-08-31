/**
 * @module L6.Watchdog.MotionRestartState
 * Pure state machine for durable motion restart backoff/circuit decisions.
 *
 * Phase 1164: restart/backoff/circuit state is no longer local to runWatchdogLoop;
 * this module owns the transition logic only, with no I/O or audit side effects.
 */

import type { MotionRestartState } from './watchdog-context.js';
import type { ProcessSpawnConflictReason } from '../foundation/process-manager/index.js';

type MotionRestartDecision =
  | { action: 'healthy'; state: MotionRestartState; recoveredAttempts: number }
  | { action: 'defer'; state: MotionRestartState; waitMs: number }
  | { action: 'circuit_open'; state: MotionRestartState; justOpened: boolean }
  | { action: 'attempt'; state: MotionRestartState };

export function decideMotionRestart(
  state: MotionRestartState,
  motionAlive: boolean,
  now: number,
  maxAttempts: number,
): MotionRestartDecision {
  if (motionAlive) {
    const recoveredAttempts =
      state.status === 'closed' ? 0 : state.consecutiveAttempts;
    return {
      action: 'healthy',
      state: { status: 'closed', consecutiveAttempts: 0 },
      recoveredAttempts,
    };
  }

  if (state.status === 'open') {
    return { action: 'circuit_open', state, justOpened: false };
  }

  if (
    state.status === 'retrying'
    && state.consecutiveAttempts >= maxAttempts
  ) {
    return {
      action: 'circuit_open',
      state: {
        status: 'open',
        consecutiveAttempts: state.consecutiveAttempts,
        openedAt: now,
      },
      justOpened: true,
    };
  }

  if (state.status === 'retrying' && now < state.nextAttemptAt) {
    return {
      action: 'defer',
      state: { ...state, awaitingStability: false },
      waitMs: state.nextAttemptAt - now,
    };
  }

  return { action: 'attempt', state };
}

export type MotionSpawnOutcome =
  | { kind: 'spawned'; pid: number }
  | { kind: 'failed'; error: unknown }
  | { kind: 'spawn_conflict'; reason: ProcessSpawnConflictReason };

export function reduceMotionRestartOutcome(
  prior: MotionRestartState,
  outcome: MotionSpawnOutcome,
  now: number,
  baseIntervalMs: number,
  maxBackoffMs: number,
): MotionRestartState {
  // Phase 1235: 只有合法 spawn ownership conflict（另一实例是磁盘 winner）可清零
  // backoff；malformed generation state 经 failed 分支累计 attempt。
  if (outcome.kind === 'spawn_conflict') {
    return { status: 'closed', consecutiveAttempts: 0 };
  }

  const priorAttempts =
    prior.status === 'closed' ? 0 : prior.consecutiveAttempts;
  const consecutiveAttempts = priorAttempts + 1;
  const delayMs = Math.min(
    baseIntervalMs * Math.pow(2, consecutiveAttempts - 1),
    maxBackoffMs,
  );
  return {
    status: 'retrying',
    consecutiveAttempts,
    nextAttemptAt: now + delayMs,
    awaitingStability: outcome.kind === 'spawned',
  };
}
