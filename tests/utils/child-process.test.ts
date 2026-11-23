import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ChildProcessLifecycleError,
  ChildProcessTimeoutError,
  runChildProcess,
  withCleanupPreservingError,
} from './child-process.js';
import { getRunRoot } from './run-root.js';
import { createTrackedTempDir, cleanupTempDir } from './temp.js';

const CHILD_TIMEOUT_MS = 100;
const CHILD_KILL_GRACE_MS = 100;
const CHILD_EXIT_CONFIRM_MS = 500;
const CANCELLATION_EXECUTION_TIMEOUT_MS = 5_000;
const CANCEL_RUNNING_CHILD_AFTER_MS = 50;
const KEEP_ALIVE_INTERVAL_MS = 1_000;
const OWNED_PROCESS_REAP_TIMEOUT_MS = 5_000;
const PROCESS_POLL_INTERVAL_MS = 20;
const DESCENDANT_EXECUTION_TIMEOUT_MS = 750;
const DESCENDANT_KILL_GRACE_MS = 100;
const DESCENDANT_EXIT_CONFIRM_MS = 150;
const DESCENDANT_SCHEDULING_MARGIN_MS = 500;
const DESCENDANT_NATURAL_EXIT_MS = 2_500;
const DESCENDANT_HANDSHAKE_TIMEOUT_MS = 6_000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function captureFailure(run: Promise<unknown>): Promise<unknown> {
  return run.then(() => undefined, (error: unknown) => error);
}

function isOwnedProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForOwnedProcessExit(pid: number, timeoutMs = OWNED_PROCESS_REAP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isOwnedProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Owned process ${pid} did not exit within ${timeoutMs}ms`);
    await delay(PROCESS_POLL_INTERVAL_MS);
  }
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`File ${filePath} was not ready within ${timeoutMs}ms`);
    await delay(PROCESS_POLL_INTERVAL_MS);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('test child process lifecycle', () => {
  it('preserves normal business result fields and close evidence', async () => {
    const result = await runChildProcess(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7;'],
      { timeoutMs: CANCELLATION_EXECUTION_TIMEOUT_MS },
    );

    expect(result).toMatchObject({
      status: 7,
      signal: null,
      stdout: 'out',
      stderr: 'err',
      directChild: { state: 'exited', status: 7, signal: null },
      stdio: 'closed',
      outputTruncated: false,
      outputTruncatedAt: null,
      errors: [],
    });
  });

  it('preserves timeout cause and TERM/exit/close evidence', async () => {
    const failure = await captureFailure(runChildProcess(
      process.execPath,
      ['-e', `setInterval(() => {}, ${KEEP_ALIVE_INTERVAL_MS})`],
      {
        timeoutMs: CHILD_TIMEOUT_MS,
        killGraceMs: CHILD_KILL_GRACE_MS,
        exitConfirmMs: CHILD_EXIT_CONFIRM_MS,
      },
    ));

    expect(failure).toBeInstanceOf(ChildProcessTimeoutError);
    if (!(failure instanceof ChildProcessTimeoutError)) throw new Error('expected ChildProcessTimeoutError');
    expect(failure.cause).toMatchObject({ code: 'ETIMEDOUT', syscall: 'spawn' });
    expect(failure.details).toMatchObject({
      reason: 'timeout',
      timeoutMs: CHILD_TIMEOUT_MS,
      status: null,
      signal: 'SIGTERM',
      directChild: { state: 'exited', status: null, signal: 'SIGTERM' },
      stdio: 'closed',
      cleanup: 'closed',
      outputTruncated: false,
      resourceEvidence: { state: 'not_required', reason: 'exit_confirmed' },
    });
    expect(failure.details.pid).toEqual(expect.any(Number));
    expect(failure.details.killSignals).toContain('SIGTERM');
    expect(failure.message).toContain(`pid=${failure.details.pid}`);
    expect(failure.message).toContain(`timeoutMs=${CHILD_TIMEOUT_MS}`);
  });

  it('does not spawn for a pre-cancelled signal', async () => {
    const controller = new AbortController();
    const cause = new Error('cancel before spawn');
    controller.abort(cause);
    const missingCommand = path.join(getRunRoot()!, `not-spawned-${randomUUID()}`);

    const failure = await captureFailure(runChildProcess(missingCommand, [], {
      timeoutMs: CHILD_TIMEOUT_MS,
      signal: controller.signal,
    }));

    expect(failure).toBeInstanceOf(ChildProcessLifecycleError);
    if (!(failure instanceof ChildProcessLifecycleError)) throw new Error('expected lifecycle failure');
    expect(failure).not.toBeInstanceOf(ChildProcessTimeoutError);
    expect(failure.details.reason).toBe('cancelled');
    expect(failure.details.pid).toBeUndefined();
    expect(failure.details.killAttempts).toEqual([]);
    expect(failure.details.resourceEvidence).toEqual({ state: 'not_required', reason: 'pid_unavailable' });
    expect(failure.cause).toBe(cause);
  });

  it('locks cancellation as the first reason and joins a running child', async () => {
    const controller = new AbortController();
    const cause = new Error('cancel running child');
    const abortTimer = setTimeout(() => controller.abort(cause), CANCEL_RUNNING_CHILD_AFTER_MS);
    let failure: unknown;
    try {
      failure = await captureFailure(runChildProcess(
        process.execPath,
        ['-e', `setInterval(() => {}, ${KEEP_ALIVE_INTERVAL_MS})`],
        {
          timeoutMs: CANCELLATION_EXECUTION_TIMEOUT_MS,
          killGraceMs: CHILD_KILL_GRACE_MS,
          exitConfirmMs: CHILD_EXIT_CONFIRM_MS,
          signal: controller.signal,
        },
      ));
    } finally {
      clearTimeout(abortTimer);
    }

    expect(failure).toBeInstanceOf(ChildProcessLifecycleError);
    if (!(failure instanceof ChildProcessLifecycleError)) throw new Error('expected lifecycle failure');
    expect(failure.details).toMatchObject({
      reason: 'cancelled',
      signal: 'SIGTERM',
      directChild: { state: 'exited', signal: 'SIGTERM' },
      stdio: 'closed',
    });
    expect(failure.cause).toBe(cause);
  });

  it('escalates to SIGKILL only when the direct child ignores SIGTERM', async () => {
    const failure = await captureFailure(runChildProcess(
      process.execPath,
      ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, ${KEEP_ALIVE_INTERVAL_MS})`],
      {
        timeoutMs: CHILD_TIMEOUT_MS,
        killGraceMs: CHILD_KILL_GRACE_MS,
        exitConfirmMs: CHILD_EXIT_CONFIRM_MS,
      },
    ));

    expect(failure).toBeInstanceOf(ChildProcessTimeoutError);
    if (!(failure instanceof ChildProcessTimeoutError)) throw new Error('expected ChildProcessTimeoutError');
    expect(failure.details.killAttempts.map(attempt => attempt.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(failure.details.signal).toBe('SIGKILL');
    expect(failure.details.directChild).toEqual({ state: 'exited', status: null, signal: 'SIGKILL' });
  });

  it('retains a false kill result while observing the real child exit', async () => {
    const originalKill = ChildProcess.prototype.kill;
    vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(
      function (this: ChildProcess, signal?: NodeJS.Signals | number): boolean {
        const sent = originalKill.call(this, signal);
        return signal === 'SIGTERM' ? false : sent;
      },
    );

    const failure = await captureFailure(runChildProcess(
      process.execPath,
      ['-e', `setInterval(() => {}, ${KEEP_ALIVE_INTERVAL_MS})`],
      {
        timeoutMs: CHILD_TIMEOUT_MS,
        killGraceMs: CHILD_KILL_GRACE_MS,
        exitConfirmMs: CHILD_EXIT_CONFIRM_MS,
      },
    ));

    expect(failure).toBeInstanceOf(ChildProcessTimeoutError);
    if (!(failure instanceof ChildProcessTimeoutError)) throw new Error('expected ChildProcessTimeoutError');
    expect(failure.details.killAttempts[0]).toEqual({ signal: 'SIGTERM', sent: false });
    expect(failure.details.killSignals).not.toContain('SIGTERM');
    expect(failure.details.directChild.state).toBe('exited');
  });

  it('retains a thrown kill error without replacing the timeout cause', async () => {
    const originalKill = ChildProcess.prototype.kill;
    const killFailure = new Error('injected kill failure');
    vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(
      function (this: ChildProcess, signal?: NodeJS.Signals | number): boolean {
        const sent = originalKill.call(this, signal);
        if (signal === 'SIGTERM') throw killFailure;
        return sent;
      },
    );

    const failure = await captureFailure(runChildProcess(
      process.execPath,
      ['-e', `setInterval(() => {}, ${KEEP_ALIVE_INTERVAL_MS})`],
      {
        timeoutMs: CHILD_TIMEOUT_MS,
        killGraceMs: CHILD_KILL_GRACE_MS,
        exitConfirmMs: CHILD_EXIT_CONFIRM_MS,
      },
    ));

    expect(failure).toBeInstanceOf(ChildProcessTimeoutError);
    if (!(failure instanceof ChildProcessTimeoutError)) throw new Error('expected ChildProcessTimeoutError');
    expect(failure.details.killAttempts[0]).toEqual({ signal: 'SIGTERM', sent: false, error: killFailure });
    expect(failure.details.killError).toBe(killFailure);
    expect(failure.details.killErrors).toEqual([killFailure]);
    expect(failure.cause).toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('detaches descendant-held stdio at the confirmation budget and reaps the natural probe', async () => {
    const fixtureDir = await createTrackedTempDir('child-descendant-');
    const readyPath = path.join(fixtureDir, 'ready');
    const pidPath = path.join(fixtureDir, 'pid');
    const exitedPath = path.join(fixtureDir, 'exited');
    const descendantSource = `
      const fs = require('node:fs');
      process.send?.('ready');
      setTimeout(() => fs.writeFileSync(process.argv[1], 'exited'), ${DESCENDANT_NATURAL_EXIT_MS});
    `;
    const parentSource = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const [readyPath, pidPath, exitedPath] = process.argv.slice(1);
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}, exitedPath], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      fs.writeFileSync(pidPath, String(descendant.pid));
      descendant.on('message', message => {
        if (message === 'ready') {
          fs.writeFileSync(readyPath, String(descendant.pid));
          console.log('descendant-ready:' + descendant.pid);
        }
      });
      setInterval(() => {}, ${KEEP_ALIVE_INTERVAL_MS});
    `;
    let descendantPid: number | undefined;
    try {
      const startedAt = Date.now();
      const failure = await captureFailure(runChildProcess(
        process.execPath,
        ['-e', parentSource, readyPath, pidPath, exitedPath],
        {
          timeoutMs: DESCENDANT_EXECUTION_TIMEOUT_MS,
          killGraceMs: DESCENDANT_KILL_GRACE_MS,
          exitConfirmMs: DESCENDANT_EXIT_CONFIRM_MS,
        },
      ));
      const elapsedMs = Date.now() - startedAt;

      expect(failure).toBeInstanceOf(ChildProcessTimeoutError);
      if (!(failure instanceof ChildProcessTimeoutError)) throw new Error('expected ChildProcessTimeoutError');
      expect(failure.details.directChild).toEqual({ state: 'exited', status: null, signal: 'SIGTERM' });
      expect(failure.details.stdio).toBe('detached');
      expect(failure.details.outputTruncated).toBe(true);
      expect(failure.details.outputTruncatedAt).toEqual(expect.any(String));
      expect(failure.details.stdout).toContain('descendant-ready:');
      expect(elapsedMs).toBeLessThan(
        DESCENDANT_EXECUTION_TIMEOUT_MS + DESCENDANT_KILL_GRACE_MS +
        DESCENDANT_EXIT_CONFIRM_MS + DESCENDANT_SCHEDULING_MARGIN_MS,
      );

      await waitForFile(readyPath, DESCENDANT_HANDSHAKE_TIMEOUT_MS);
      descendantPid = Number(fs.readFileSync(readyPath, 'utf8'));
      await waitForFile(exitedPath, DESCENDANT_HANDSHAKE_TIMEOUT_MS);
      await waitForOwnedProcessExit(descendantPid);
    } finally {
      if (!descendantPid && fs.existsSync(pidPath)) descendantPid = Number(fs.readFileSync(pidPath, 'utf8'));
      if (descendantPid && isOwnedProcessAlive(descendantPid)) {
        process.kill(descendantPid, 'SIGKILL');
      }
      if (descendantPid) await waitForOwnedProcessExit(descendantPid);
      await cleanupTempDir(fixtureDir);
    }
  });

  it('reports spawn failure as a structured first reason', async () => {
    const missingCommand = path.join(getRunRoot()!, `missing-executable-${randomUUID()}`);
    const failure = await captureFailure(runChildProcess(missingCommand, [], {
      timeoutMs: CANCELLATION_EXECUTION_TIMEOUT_MS,
      exitConfirmMs: CHILD_EXIT_CONFIRM_MS,
    }));

    expect(failure).toBeInstanceOf(ChildProcessLifecycleError);
    if (!(failure instanceof ChildProcessLifecycleError)) throw new Error('expected lifecycle failure');
    expect(failure.details).toMatchObject({
      reason: 'spawn_error',
      pid: undefined,
      directChild: { state: 'unconfirmed' },
      stdio: 'closed',
      resourceEvidence: { state: 'not_required', reason: 'pid_unavailable' },
    });
    expect(failure.cause).toMatchObject({ code: 'ENOENT' });
    expect(failure.details.errors).toHaveLength(1);
  });

  it('aggregates the primary timeout with evidence recording failure and reaps the owned child', async () => {
    const originalRunRoot = process.env.CHESTNUT_RUN_ROOT;
    const missingRunRoot = path.join(getRunRoot()!, `missing-run-root-${randomUUID()}`);
    process.env.CHESTNUT_RUN_ROOT = missingRunRoot;
    vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(false);
    let childPid: number | undefined;
    try {
      const failure = await captureFailure(runChildProcess(
        process.execPath,
        ['-e', `setInterval(() => {}, ${KEEP_ALIVE_INTERVAL_MS})`],
        {
          timeoutMs: CHILD_TIMEOUT_MS,
          killGraceMs: CHILD_KILL_GRACE_MS,
          exitConfirmMs: CHILD_TIMEOUT_MS,
        },
      ));

      if (failure instanceof AggregateError && failure.errors[0] instanceof ChildProcessTimeoutError) {
        childPid = failure.errors[0].details.pid;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error('expected AggregateError');
      expect(failure.errors[0]).toBeInstanceOf(ChildProcessTimeoutError);
      const primary = failure.errors[0] as ChildProcessTimeoutError;
      expect(primary.details.directChild).toEqual({ state: 'unconfirmed' });
      expect(primary.details.stdio).toBe('detached');
      expect(primary.details.resourceEvidence).toEqual({
        state: 'failed',
        path: path.join(missingRunRoot, 'test-resource-failures.jsonl'),
      });
      expect(failure.errors.length).toBeGreaterThan(1);
      expect(failure.cause).toBe(primary);
    } finally {
      vi.restoreAllMocks();
      if (originalRunRoot === undefined) delete process.env.CHESTNUT_RUN_ROOT;
      else process.env.CHESTNUT_RUN_ROOT = originalRunRoot;
      if (childPid && isOwnedProcessAlive(childPid)) process.kill(childPid, 'SIGKILL');
      if (childPid) await waitForOwnedProcessExit(childPid);
    }
  });

  it('retains the original failure when cleanup also fails', async () => {
    const original = new Error('original child failure');
    const cleanup = new Error('cleanup failure');
    const failure = await captureFailure(withCleanupPreservingError(
      async () => { throw original; },
      async () => { throw cleanup; },
    ));

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('expected AggregateError');
    expect(failure.errors).toEqual([original, cleanup]);
    expect(failure.cause).toBe(original);
  });
});
