/**
 * Phase 769 — L1 ProcessExec execWithHandle tests
 *
 * Verifies that execWithHandle returns both a promise and an immediately
 * available ChildProcess handle, preserving all existing exec semantics.
 */

import { describe, it, expect, vi } from 'vitest';
import { execWithHandle, ProcessExecError, probeExecutionGroup, terminateExecutionGroup, getProcessStartTime } from '../../../src/foundation/process-exec/index.js';
import { isProcessGroupAlive } from '../../../src/foundation/process-exec/execution-group.js';
import { PROCESS_EXEC_TIMEOUT_MAX_MS } from '../../../src/foundation/process-exec/constants.js';
import * as os from 'os';

/**
 * Subprocess one-minute hang: keeps the child alive far beyond every test
 * budget so termination always comes from the test's own terminate/abort,
 * never from natural exit. Derivation: 60s ≫ it-level timeout 20s.
 */
const SUBPROCESS_HANG_MS = 60_000;

describe('execWithHandle', () => {
  it('publishes the execution identity synchronously before returning the handle', async () => {
    let observedPid: number | undefined;
    const handle = execWithHandle('sh', ['-c', 'echo checkpoint'], {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      cwd: os.tmpdir(),
      onExecutionIdentity: (identity) => { observedPid = identity.leaderPid; },
    });

    expect(observedPid).toBe(handle.identity?.leaderPid);
    await expect(handle.promise).resolves.toMatchObject({ exitCode: 0 });
  });

  it('should resolve with output for successful command', async () => {
    const handle = execWithHandle('sh', ['-c', 'echo hello'], {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      cwd: os.tmpdir(),
    });
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('hello');
  });

  it('should expose child process immediately after call', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      cwd: os.tmpdir(),
    });
    expect(handle.child).toBeDefined();
    expect(handle.child.pid).toBeGreaterThan(0);
    await handle.terminate();
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);
  });

  it('should reject ProcessExecError for non-zero exit', async () => {
    const handle = execWithHandle('sh', ['-c', 'exit 7'], {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      cwd: os.tmpdir(),
    });
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);
    await expect(handle.promise).rejects.toMatchObject({
      exitCode: 7,
    });
  });

  it('should reject ProcessExecError on timeout', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      cwd: os.tmpdir(),
      timeout: 10,
      __testMinTimeoutMs: 1,
      __testSigkillGraceMs: 50,
    });
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);
    await expect(handle.promise).rejects.toMatchObject({
      killed: true,
    });
  });

  it('should support stdin pipe', async () => {
    const handle = execWithHandle('sh', ['-c', 'cat'], {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      cwd: os.tmpdir(),
      stdin: 'piped content',
    });
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('piped content');
  });

  it('should allow caller to terminate the execution before completion', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      cwd: os.tmpdir(),
    });
    expect(handle.identity).toBeDefined();
    const outcome = await handle.terminate();
    expect(outcome.status).toBe('gone');
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);
  });

  it('should work with __testMinTimeoutMs for fast tests', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], {
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      cwd: os.tmpdir(),
      timeout: 5,
      __testMinTimeoutMs: 1,
      __testSigkillGraceMs: 50,
    });
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);
  });
});

/**
 * Phase 1269 Step B — execution identity + L1-owned idempotent terminate()
 */
describe('execWithHandle execution identity and terminate (phase 1269)', () => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const workDir = os.tmpdir();

  it('exposes execution identity: PGID === leader PID, never the test runner group', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], { cwd: workDir });
    expect(handle.identity).toBeDefined();
    const identity = handle.identity!;
    expect(identity.leaderPid).toBe(handle.child.pid);
    // detached: true → leader is its own process-group leader
    expect(identity.processGroupId).toBe(identity.leaderPid);
    // Safety invariant: the group must never be our own / the runner's group,
    // otherwise a negative-PGID signal could kill the test runner.
    expect(identity.processGroupId).not.toBe(process.pid);
    expect(identity.processGroupId).not.toBe(process.ppid);
    const outcome = await handle.terminate();
    expect(outcome.identity).toEqual(identity);
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);
  });

  it('terminate() kills the whole group including same-group descendants', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 30 & echo SLEEP_PID:$!; wait'], {
      cwd: workDir,
    });
    const identity = handle.identity!;
    // Wait until the shell actually spawned the descendant; terminating at
    // t≈0 could TERM the shell before it even runs echo (startup race).
    const sleepPid = await waitForMatch(handle, /SLEEP_PID:(\d+)/);
    const outcome = await handle.terminate();
    expect(outcome.status).toBe('gone');
    expect(outcome.termSent).toBe(true);
    const err = await handle.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessExecError);
    expect(isAlivePid(sleepPid)).toBe(false);
    expect(isProcessGroupAlive(identity.processGroupId)).toBe(false);
  }, 20_000);

  it('terminate() is idempotent: concurrent calls share one run and one trigger', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], { cwd: workDir });
    const p1 = handle.terminate();
    const p2 = handle.terminate();
    expect(p1).toBe(p2); // same in-flight promise — no second timer set
    const outcome = await p1;
    expect(outcome.trigger).toBe('caller_requested');
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);
  });

  it('repeat terminate() does not send a second TERM/KILL sequence nor extend the earliest deadline', async () => {
    // Leader traps SIGTERM so the full TERM→grace→KILL sequence runs; a
    // second terminate() mid-flight must not re-signal or shift the deadline.
    // SIGKILL_GRACE_MS: short grace so the escalation completes fast in-test.
    // MID_GRACE_DELAY_MS = grace / 2: the second terminate() lands strictly
    // inside the grace window — single semantic source, no 100/50 drift.
    const SIGKILL_GRACE_MS = 100;
    const MID_GRACE_DELAY_MS = SIGKILL_GRACE_MS / 2;
    const killSpy = vi.spyOn(process, 'kill');
    const handle = execWithHandle(
      'node',
      ['-e', `process.on('SIGTERM', () => {}); console.log('READY'); setTimeout(() => {}, ${SUBPROCESS_HANG_MS})`],
      { cwd: workDir, __testSigkillGraceMs: SIGKILL_GRACE_MS },
    );
    const pgid = handle.identity!.processGroupId;
    // Wait until the SIGTERM trap is installed; terminating before node
    // boots would hit the default TERM action instead of the escalation path.
    await waitForMatch(handle, /READY/);
    const p1 = handle.terminate();
    await new Promise((resolve) => setTimeout(resolve, MID_GRACE_DELAY_MS));
    const p2 = handle.terminate();
    expect(p2).toBe(p1);
    const outcome = await p1;
    expect(outcome.status).toBe('gone');
    expect(outcome.killSent).toBe(true);
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);

    const groupTerms = killSpy.mock.calls.filter(
      ([pid, sig]) => pid === -pgid && sig === 'SIGTERM',
    );
    const groupKills = killSpy.mock.calls.filter(
      ([pid, sig]) => pid === -pgid && sig === 'SIGKILL',
    );
    expect(groupTerms).toHaveLength(1);
    expect(groupKills).toHaveLength(1);
    killSpy.mockRestore();
  }, 20_000);
});

function isAlivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Accumulate child stdout until `pattern` matches; returns capture group 1 or full match. */
function waitForMatch(
  handle: { child: import('child_process').ChildProcess },
  pattern: RegExp,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const m = buf.match(pattern);
      if (m) {
        handle.child.stdout?.off('data', onData);
        resolve(m[1] ?? m[0]);
      }
    };
    handle.child.stdout?.on('data', onData);
    handle.child.on('close', () => reject(new Error(`closed before match: ${pattern}`)));
  });
}

/**
 * Phase 1269 Step C — promise settle 与 termination outcome 一致性
 */
describe('execWithHandle abort convergence (phase 1269 Step C)', () => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const workDir = os.tmpdir();

  it('mid-flight abort: promise rejection carries the same facts as the termination outcome', async () => {
    // ABORT_AFTER_START_MS: lets the child finish spawn/startup, still far
    // earlier than the natural sleep-30 exit — the abort always lands
    // mid-flight, never before exec begins nor after completion.
    const ABORT_AFTER_START_MS = 100;
    const controller = new AbortController();
    const handle = execWithHandle('sh', ['-c', 'sleep 30'], {
      cwd: workDir,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), ABORT_AFTER_START_MS);
    const err = await handle.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessExecError);
    const error = err as ProcessExecError;
    expect(error.termination).toBeDefined();
    expect(error.termination!.trigger).toBe('abort');
    expect(error.termination!.status).toBe('gone');
    expect(error.termination!.identity).toEqual(handle.identity);
    // A late terminate() reuses the concluded run: same facts, no new signals.
    const outcome = await handle.terminate();
    expect(outcome.trigger).toBe('abort'); // first trigger wins, not caller_requested
    expect(outcome.status).toBe('gone');
  }, 20_000);

  it('spawn failure raced by terminate() settles via onRejected, never an unhandled rejection', async () => {
    // phase 1271 F4: when spawn fails (no pid → identity undefined) and
    // terminate() lands before the spawn 'error' event, the close handler's
    // derived promise must have a consumer. Without the onRejected branch the
    // daemon's unhandledRejection handler would exit(1).
    const handle = execWithHandle('no-such-command-phase1271', ['--nope'], {
      cwd: workDir,
    });
    expect(handle.identity).toBeUndefined();
    // terminate() synchronously right after spawn: inside the abort-race window
    // before the ENOENT error event is delivered.
    await expect(handle.terminate()).rejects.toBeInstanceOf(ProcessExecError);
    await expect(handle.promise).rejects.toMatchObject({
      message: expect.stringContaining('Cannot terminate: process never started'),
    });
  }, 20_000);

  it('pre-aborted signal throws synchronously with not_started facts and never spawns', () => {
    const controller = new AbortController();
    controller.abort();
    try {
      execWithHandle('sh', ['-c', 'echo SHOULD_NOT_RUN'], {
        cwd: workDir,
        signal: controller.signal,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      const error = err as ProcessExecError;
      expect(error.termination!.trigger).toBe('abort');
      expect(error.termination!.reason).toBe('not_started');
      expect(error.termination!.identity).toBeUndefined();
    }
  });

  it('SIGKILL close signal is surfaced on the error, not parsed from the message', async () => {
    const handle = execWithHandle(
      'node',
      ['-e', `process.on('SIGTERM', () => {}); console.log('READY'); setTimeout(() => {}, ${SUBPROCESS_HANG_MS})`],
      { cwd: workDir, __testSigkillGraceMs: 100 },
    );
    await waitForMatch(handle, /READY/);
    const outcome = await handle.terminate();
    expect(outcome.killSent).toBe(true);
    const err = await handle.promise.catch((e: unknown) => e);
    const error = err as ProcessExecError;
    expect(error.signal).toBe('SIGKILL');
    expect(error.termination!.status).toBe('gone');
    expect(error.termination!.killSent).toBe(true);
  }, 20_000);
});

/**
 * Phase 1269 Step F — persisted-identity recovery probe against the REAL OS.
 *
 * These tests must not mock probeExecutionGroup: they create a genuine
 * detached execution group, persist+rehydrate the identity (JSON round-trip),
 * and drive the production probe/terminate path end to end.
 */
describe('persisted identity recovery probe (phase 1269 Step F, real OS)', () => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const workDir = os.tmpdir();

  it('production probe verifies a live persisted v1 identity after JSON round-trip', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 30'], { cwd: workDir });
    const identity = handle.identity!;
    // Attach the rejection handler up front: terminating via the L1 group
    // entry rejects the promise asynchronously, and a late attach reads as an
    // unhandled rejection.
    const settled = handle.promise.then(() => null, (e: unknown) => e);
    try {
      // Simulate daemon restart: identity survives only as JSON on disk.
      const persisted = JSON.parse(JSON.stringify(identity)) as typeof identity;
      const leaderStartTime = getProcessStartTime(persisted.leaderPid);
      expect(leaderStartTime).toBeDefined();

      expect(probeExecutionGroup(persisted, leaderStartTime)).toEqual({ kind: 'verified_alive' });
    } finally {
      const outcome = await terminateExecutionGroup(identity, 'caller_requested');
      expect(outcome.status).toBe('gone');
    }
    expect(await settled).toBeInstanceOf(ProcessExecError);
  });

  it('identity violating the creation invariant (PGID !== leader PID) is never verified nor signalled', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 30'], { cwd: workDir });
    const identity = handle.identity!;
    const settled = handle.promise.then(() => null, (e: unknown) => e);
    try {
      const leaderStartTime = getProcessStartTime(identity.leaderPid);
      const bogus = { leaderPid: identity.leaderPid, processGroupId: identity.leaderPid + 1 };

      expect(probeExecutionGroup(bogus, leaderStartTime)).toEqual({
        kind: 'indeterminate',
        reason: 'invalid_execution_identity',
      });

      // The termination path applies the same runtime guard — no signal at all.
      const outcome = await terminateExecutionGroup(bogus, 'caller_requested');
      expect(outcome.status).toBe('indeterminate');
      if (outcome.status === 'indeterminate') {
        expect(outcome.reason).toBe('invalid_execution_identity');
      }
      expect(outcome.termSent).toBe(false);
      expect(outcome.killSent).toBe(false);

      // The genuine leader must be completely untouched.
      expect(probeExecutionGroup(identity, leaderStartTime)).toEqual({ kind: 'verified_alive' });
    } finally {
      await terminateExecutionGroup(identity, 'caller_requested');
    }
    expect(await settled).toBeInstanceOf(ProcessExecError);
  });

  it('unsafe small values and non-integers are invalid identities', () => {
    expect(probeExecutionGroup({ leaderPid: 1, processGroupId: 1 }, 'any')).toEqual({
      kind: 'indeterminate',
      reason: 'invalid_execution_identity',
    });
    expect(probeExecutionGroup({ leaderPid: 0, processGroupId: 0 }, 'any')).toEqual({
      kind: 'indeterminate',
      reason: 'invalid_execution_identity',
    });
    expect(probeExecutionGroup({ leaderPid: 1.5, processGroupId: 1.5 }, 'any')).toEqual({
      kind: 'indeterminate',
      reason: 'invalid_execution_identity',
    });
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(probeExecutionGroup({ leaderPid: unsafe, processGroupId: unsafe }, 'any')).toEqual({
      kind: 'indeterminate',
      reason: 'invalid_execution_identity',
    });
  });

  it('live leader with mismatched start time is not verified (PID reuse defense)', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 30'], { cwd: workDir });
    const identity = handle.identity!;
    const settled = handle.promise.then(() => null, (e: unknown) => e);
    try {
      // Start time mismatch → provably not our leader; the group still
      // responds, so ownership is indeterminate and must not be signalled.
      expect(probeExecutionGroup(identity, 'Mon Jan 01 00:00:00 1999')).toEqual({
        kind: 'indeterminate',
        reason: 'leader_reused_group_alive',
      });
    } finally {
      await terminateExecutionGroup(identity, 'caller_requested');
    }
    expect(await settled).toBeInstanceOf(ProcessExecError);
  });

  it('leader gone but group still responding stays indeterminate — equality never short-circuits to kill', async () => {
    // Leader exits immediately; a background descendant (fully redirected so
    // it holds no pipes) keeps the process group alive.
    const handle = execWithHandle(
      'sh',
      ['-c', 'sleep 30 </dev/null >/dev/null 2>&1 & exit 0'],
      { cwd: workDir },
    );
    const identity = handle.identity!;
    await handle.promise; // leader exits 0; descendant lingers in the group

    // The group genuinely still responds — this is the PGID-reuse ambiguity.
    expect(isProcessGroupAlive(identity.processGroupId)).toBe(true);
    expect(probeExecutionGroup(identity, undefined)).toEqual({
      kind: 'indeterminate',
      reason: 'leader_gone_group_alive',
    });

    // Cleanup: this test created the group seconds ago, so ownership here is
    // certain — terminate it to avoid leaking the descendant.
    const outcome = await terminateExecutionGroup(identity, 'caller_requested');
    expect(outcome.status).toBe('gone');
    expect(isProcessGroupAlive(identity.processGroupId)).toBe(false);
  }, 20_000);
});


/**
 * Phase 1272 Step B — absolute deadline policy (L1-neutral primitive)
 *
 * `deadlineAtMs` (epoch ms) is a caller-supplied wall-clock fact: it is NOT
 * routed through the relative business clamp (default 30s, ceiling 600s),
 * the runtime delay is derived from the epoch fact, and Node's signed-32-bit
 * single-timer cap is handled by segmented re-arm instead of overflowing
 * into a ~1ms misfire. The relative policy is behaviorally unchanged.
 */
describe('execWithHandle absolute deadline policy (phase 1272 Step B)', () => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const workDir = os.tmpdir();

  // Short grace so TERM→KILL escalation and group-gone confirmation stay
  // cheap under both real and fake timers (same role as existing tests).
  const TEST_SIGKILL_GRACE_MS = 50;

  // Node platform fact: a single setTimeout delay is capped at the signed
  // 32-bit ms max; larger delays overflow and fire after ~1ms.
  const NODE_TIMER_DELAY_CAP_MS = 2_147_483_647;

  /**
   * Advance fake timers in small steps while yielding real event-loop turns
   * (setImmediate stays real under this file's fake-timer config), so the OS
   * can actually deliver SIGTERM and reap the child between L1's grace timer
   * and group-gone confirmation polls.
   */
  async function advanceWithRealYield(ms: number): Promise<void> {
    const STEP_MS = 25; // matches L1's group-confirm poll granularity
    for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
      await vi.advanceTimersByTimeAsync(STEP_MS);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it('absolute deadline terminates at the deadline with timeout facts (real timers)', async () => {
    const DEADLINE_AHEAD_MS = 50; // ≫ scheduling jitter, ≪ any test budget
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], {
      cwd: workDir,
      deadlineAtMs: Date.now() + DEADLINE_AHEAD_MS,
      __testSigkillGraceMs: TEST_SIGKILL_GRACE_MS,
    });
    const err = await handle.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessExecError);
    const error = err as ProcessExecError;
    expect(error.message).toContain('absolute deadline');
    expect(error.termination!.trigger).toBe('timeout');
    expect(error.termination!.status).toBe('gone');
    expect(isAlivePid(handle.identity!.leaderPid)).toBe(false);
  }, 20_000);

  it('an already-passed deadline enters the shared termination path immediately', async () => {
    const ALREADY_ELAPSED_MS = 1_000; // any positive past offset proves the ≤0 branch
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], {
      cwd: workDir,
      deadlineAtMs: Date.now() - ALREADY_ELAPSED_MS,
      __testSigkillGraceMs: TEST_SIGKILL_GRACE_MS,
    });
    const err = await handle.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessExecError);
    const error = err as ProcessExecError;
    expect(error.termination!.trigger).toBe('timeout');
    expect(error.termination!.status).toBe('gone');
  }, 20_000);

  it('invalid deadlineAtMs values throw synchronously before any spawn', () => {
    const invalid = [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -5];
    for (const value of invalid) {
      try {
        execWithHandle('sh', ['-c', 'echo SHOULD_NOT_RUN'], {
          cwd: workDir,
          deadlineAtMs: value,
        });
        expect.fail(`should have thrown for deadlineAtMs=${String(value)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ProcessExecError);
        expect((err as ProcessExecError).message).toContain('Invalid deadlineAtMs');
      }
    }
  });

  it('timeout and deadlineAtMs together are rejected at the entry (mutual exclusion)', () => {
    try {
      // @ts-expect-error phase 1272: relative timeout and absolute deadline are mutually exclusive at the type level
      execWithHandle('sh', ['-c', 'echo SHOULD_NOT_RUN'], { cwd: workDir, timeout: 1000, deadlineAtMs: Date.now() + 1000 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      expect((err as ProcessExecError).message).toContain('mutually exclusive');
    }
  });

  it('relative timeout above the 600s ceiling still clamps (existing contract, fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const REQUESTED_TIMEOUT_MS = PROCESS_EXEC_TIMEOUT_MAX_MS + 300_000; // any value above the ceiling proves the clamp
    const handle = execWithHandle('sh', ['-c', 'sleep 30'], {
      cwd: workDir,
      timeout: REQUESTED_TIMEOUT_MS,
      __testSigkillGraceMs: TEST_SIGKILL_GRACE_MS,
    });
    // Attach the consumer up front: the timer fires during fake-time
    // advancement, and a late attach reads as an unhandled rejection.
    const settledPromise = handle.promise.then(() => null, (e: unknown) => e);
    try {
      // One batch up to the clamped ceiling: fires the L1 timer and sends the
      // real SIGTERM; the grace timer (due later) is not flushed in this batch.
      await vi.advanceTimersByTimeAsync(PROCESS_EXEC_TIMEOUT_MAX_MS);
      await advanceWithRealYield(2_000); // grace + group-gone confirmation polls
      const err = await settledPromise;
      expect(err).toBeInstanceOf(ProcessExecError);
      const error = err as ProcessExecError;
      expect(error.message).toBe(`Command timed out after ${PROCESS_EXEC_TIMEOUT_MAX_MS}ms`);
      expect(error.termination!.trigger).toBe('timeout');
    } finally {
      vi.useRealTimers();
      if (handle.identity && isAlivePid(handle.identity.leaderPid)) {
        void handle.terminate().catch(() => { /* silent best-effort cleanup */ });
      }
    }
  }, 20_000);

  it('absolute deadline beyond the 600s relative ceiling is NOT clamped (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const BEYOND_CEILING_MS = 100_000; // deadline lands 100s past the relative ceiling
    const deadlineAtMs = Date.now() + PROCESS_EXEC_TIMEOUT_MAX_MS + BEYOND_CEILING_MS;
    const handle = execWithHandle('sh', ['-c', 'sleep 30'], {
      cwd: workDir,
      deadlineAtMs,
      __testSigkillGraceMs: TEST_SIGKILL_GRACE_MS,
    });
    let settled = false;
    void handle.promise.then(() => { settled = true; }, () => { settled = true; });
    try {
      // Past the relative ceiling: no termination, process alive, promise pending.
      await vi.advanceTimersByTimeAsync(PROCESS_EXEC_TIMEOUT_MAX_MS + 1);
      expect(settled).toBe(false);
      expect(isAlivePid(handle.identity!.leaderPid)).toBe(true);

      // Reach the deadline exactly: the timer fires and termination begins;
      // flush grace/polls with real yields so the group genuinely goes away.
      await vi.advanceTimersByTimeAsync(BEYOND_CEILING_MS - 1);
      await advanceWithRealYield(2_000);
      const err = await handle.promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProcessExecError);
      const error = err as ProcessExecError;
      expect(error.message).toBe(`Command timed out at absolute deadline ${deadlineAtMs}`);
      expect(error.termination!.trigger).toBe('timeout');
      expect(error.termination!.status).toBe('gone');
    } finally {
      vi.useRealTimers();
      if (handle.identity && isAlivePid(handle.identity.leaderPid)) {
        void handle.terminate().catch(() => { /* silent best-effort cleanup */ });
      }
    }
  }, 20_000);

  it('deadline beyond the Node single-timer cap is armed in segments — no 1ms overflow misfire', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const TAIL_BEYOND_CAP_MS = 5_000; // deadline = cap + tail: forces ≥2 timer segments
    const deadlineAtMs = Date.now() + NODE_TIMER_DELAY_CAP_MS + TAIL_BEYOND_CAP_MS;
    const handle = execWithHandle('sh', ['-c', 'sleep 30'], {
      cwd: workDir,
      deadlineAtMs,
      __testSigkillGraceMs: TEST_SIGKILL_GRACE_MS,
    });
    let settled = false;
    void handle.promise.then(() => { settled = true; }, () => { settled = true; });
    try {
      // An overflowed timer would have fired at ~1ms.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      expect(isAlivePid(handle.identity!.leaderPid)).toBe(true);

      // First segment expires at the cap: the deadline is still ahead, so the
      // implementation must re-arm for the remainder instead of firing.
      await vi.advanceTimersByTimeAsync(NODE_TIMER_DELAY_CAP_MS - 1_000);
      expect(settled).toBe(false);
      expect(isAlivePid(handle.identity!.leaderPid)).toBe(true);

      // The re-armed tail reaches the real deadline.
      await vi.advanceTimersByTimeAsync(TAIL_BEYOND_CAP_MS);
      await advanceWithRealYield(2_000);
      const err = await handle.promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProcessExecError);
      expect((err as ProcessExecError).termination!.trigger).toBe('timeout');
    } finally {
      vi.useRealTimers();
      if (handle.identity && isAlivePid(handle.identity.leaderPid)) {
        void handle.terminate().catch(() => { /* silent best-effort cleanup */ });
      }
    }
  }, 20_000);
});
