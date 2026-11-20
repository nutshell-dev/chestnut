import { describe, expect, it } from 'vitest';
import {
  ChildProcessTimeoutError,
  runChildProcess,
  withCleanupPreservingError,
} from './child-process.js';

const CHILD_TIMEOUT_MS = 100; // Short deterministic deadline; the fixture never exits voluntarily.
const CHILD_KILL_GRACE_MS = 100; // Escalate promptly if SIGTERM is not enough.
const KEEP_ALIVE_INTERVAL_MS = 1_000; // Keep the fixture alive until the helper kills it.

describe('test child process lifecycle', () => {
  it('preserves timeout cause and kill/exit/close evidence', async () => {
    const failure = await runChildProcess(
      process.execPath,
      ['-e', `setInterval(() => {}, ${KEEP_ALIVE_INTERVAL_MS})`],
      { timeoutMs: CHILD_TIMEOUT_MS, killGraceMs: CHILD_KILL_GRACE_MS },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ChildProcessTimeoutError);
    if (!(failure instanceof ChildProcessTimeoutError)) {
      throw new Error('expected ChildProcessTimeoutError');
    }
    expect(failure.cause).toMatchObject({ code: 'ETIMEDOUT', syscall: 'spawn' });
    expect(failure.details.pid).toEqual(expect.any(Number));
    expect(failure.details.timeoutMs).toBe(CHILD_TIMEOUT_MS);
    expect(failure.details.killSignals).toContain('SIGTERM');
    expect(failure.details.cleanup).toBe('closed');
    expect(failure.details.status).toBeNull();
    expect(failure.details.signal).toBe('SIGTERM');
    expect(failure.message).toContain(`pid=${failure.details.pid}`);
    expect(failure.message).toContain(`timeoutMs=${CHILD_TIMEOUT_MS}`);
    expect(failure.message).toContain('cleanup=closed');
  });

  it('retains the original failure when cleanup also fails', async () => {
    const original = new Error('original child failure');
    const cleanup = new Error('cleanup failure');
    const failure = await withCleanupPreservingError(
      async () => { throw original; },
      async () => { throw cleanup; },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error('expected AggregateError');
    }
    expect(failure.errors).toEqual([original, cleanup]);
    expect(failure.cause).toBe(original);
  });
});
