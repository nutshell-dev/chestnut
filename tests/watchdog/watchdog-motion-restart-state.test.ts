/**
 * Phase 1164 — pure motion restart state machine matrix.
 */
import { describe, it, expect } from 'vitest';
import {
  decideMotionRestart,
  reduceMotionRestartOutcome,
} from '../../src/watchdog/motion-restart-state.js';
import type { MotionRestartState } from '../../src/watchdog/watchdog-context.js';

const CLOSED: MotionRestartState = { status: 'closed', consecutiveAttempts: 0 };

function retrying(
  attempts: number,
  nextAttemptAt: number,
  awaitingStability: boolean,
): MotionRestartState {
  return {
    status: 'retrying',
    consecutiveAttempts: attempts,
    nextAttemptAt,
    awaitingStability,
  };
}

function open(attempts: number, openedAt: number): MotionRestartState {
  return {
    status: 'open',
    consecutiveAttempts: attempts,
    openedAt,
  };
}

describe('decideMotionRestart', () => {
  it('closed + alive -> closed, recoveredAttempts=0', () => {
    const decision = decideMotionRestart(CLOSED, true, 1_000, 10);
    expect(decision.action).toBe('healthy');
    expect(decision.state).toEqual(CLOSED);
    expect(decision.recoveredAttempts).toBe(0);
  });

  it('closed + down -> attempt', () => {
    const decision = decideMotionRestart(CLOSED, false, 1_000, 10);
    expect(decision.action).toBe('attempt');
    expect(decision.state).toEqual(CLOSED);
  });

  it('retrying awaitingStability + alive -> closed + stability audit', () => {
    const state = retrying(1, 5_000, true);
    const decision = decideMotionRestart(state, true, 10_000, 10);
    expect(decision.action).toBe('healthy');
    expect(decision.state).toEqual(CLOSED);
    expect(decision.recoveredAttempts).toBe(1);
  });

  it('retrying awaitingStability + down before nextAttemptAt -> defer, awaitingStability=false', () => {
    const state = retrying(1, 5_000, true);
    const decision = decideMotionRestart(state, false, 3_000, 10);
    expect(decision.action).toBe('defer');
    expect(decision.state).toEqual(retrying(1, 5_000, false));
    expect(decision.waitMs).toBe(2_000);
  });

  it('retrying + down due -> attempt', () => {
    const state = retrying(2, 5_000, false);
    const decision = decideMotionRestart(state, false, 5_000, 10);
    expect(decision.action).toBe('attempt');
    expect(decision.state).toEqual(state);
  });

  it('retrying attempts=max + down -> open exactly once', () => {
    const state = retrying(10, 5_000, false);
    const decision = decideMotionRestart(state, false, 10_000, 10);
    expect(decision.action).toBe('circuit_open');
    expect(decision.state).toEqual(open(10, 10_000));
    expect(decision.justOpened).toBe(true);
  });

  it('open + down -> circuit_open, justOpened=false', () => {
    const state = open(10, 8_000);
    const decision = decideMotionRestart(state, false, 10_000, 10);
    expect(decision.action).toBe('circuit_open');
    expect(decision.state).toEqual(state);
    expect(decision.justOpened).toBe(false);
  });

  it('open + alive -> closed + recovered attempts', () => {
    const state = open(10, 8_000);
    const decision = decideMotionRestart(state, true, 10_000, 10);
    expect(decision.action).toBe('healthy');
    expect(decision.state).toEqual(CLOSED);
    expect(decision.recoveredAttempts).toBe(10);
  });

  it('defer waitMs=0 when now >= nextAttemptAt -> attempt', () => {
    const state = retrying(2, 5_000, false);
    const decision = decideMotionRestart(state, false, 6_000, 10);
    expect(decision.action).toBe('attempt');
  });
});

describe('reduceMotionRestartOutcome', () => {
  it('closed + spawned -> retrying attempts=1 awaitingStability=true', () => {
    const next = reduceMotionRestartOutcome(
      CLOSED,
      { kind: 'spawned', pid: 42 },
      1_000,
      5_000,
      300_000,
    );
    expect(next).toEqual({
      status: 'retrying',
      consecutiveAttempts: 1,
      nextAttemptAt: 6_000,
      awaitingStability: true,
    });
  });

  it('closed + failed -> retrying attempts=1 awaitingStability=false', () => {
    const next = reduceMotionRestartOutcome(
      CLOSED,
      { kind: 'failed', error: new Error('boom') },
      1_000,
      5_000,
      300_000,
    );
    expect(next).toEqual({
      status: 'retrying',
      consecutiveAttempts: 1,
      nextAttemptAt: 6_000,
      awaitingStability: false,
    });
  });

  it('retrying attempts=1 + spawned -> attempts=2 awaitingStability=true', () => {
    const next = reduceMotionRestartOutcome(
      retrying(1, 5_000, false),
      { kind: 'spawned', pid: 42 },
      10_000,
      5_000,
      300_000,
    );
    expect(next).toEqual({
      status: 'retrying',
      consecutiveAttempts: 2,
      nextAttemptAt: 20_000,
      awaitingStability: true,
    });
  });

  it('retrying attempts=3 + failed -> attempts=4 with doubled backoff', () => {
    const next = reduceMotionRestartOutcome(
      retrying(3, 5_000, false),
      { kind: 'failed', error: new Error('boom') },
      10_000,
      5_000,
      300_000,
    );
    expect(next).toEqual({
      status: 'retrying',
      consecutiveAttempts: 4,
      nextAttemptAt: 50_000,
      awaitingStability: false,
    });
  });

  it.each(['active_owner', 'spawn_in_progress', 'commit_lost'] as const)(
    'spawn conflict(%s) -> closed attempts=0',
    (reason) => {
      const next = reduceMotionRestartOutcome(
        retrying(5, 5_000, false),
        { kind: 'spawn_conflict', reason },
        10_000,
        5_000,
        300_000,
      );
      expect(next).toEqual(CLOSED);
    },
  );

  it('generation state failure -> failed branch accumulates attempts (Phase 1235)', () => {
    // malformed generation 不得解释为合法竞争：必须走 failed/backoff
    const next = reduceMotionRestartOutcome(
      retrying(5, 5_000, false),
      { kind: 'failed', error: new Error('malformed generation') },
      10_000,
      5_000,
      300_000,
    );
    expect(next.status).toBe('retrying');
    expect(next.consecutiveAttempts).toBe(6);
  });

  it('backoff caps at maxBackoffMs', () => {
    const next = reduceMotionRestartOutcome(
      retrying(9, 5_000, false),
      { kind: 'failed', error: new Error('boom') },
      1_000,
      5_000,
      300_000,
    );
    expect(next.status).toBe('retrying');
    expect(next.consecutiveAttempts).toBe(10);
    expect((next as any).nextAttemptAt).toBe(301_000);
  });
});
