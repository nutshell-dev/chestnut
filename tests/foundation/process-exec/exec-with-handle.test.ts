/**
 * Phase 769 — L1 ProcessExec execWithHandle tests
 *
 * Verifies that execWithHandle returns both a promise and an immediately
 * available ChildProcess handle, preserving all existing exec semantics.
 */

import { describe, it, expect, vi } from 'vitest';
import { execWithHandle, ProcessExecError, isProcessGroupAlive, probeExecutionGroup, terminateExecutionGroup, getProcessStartTime } from '../../../src/foundation/process-exec/index.js';
import * as os from 'os';

/**
 * Subprocess one-minute hang: keeps the child alive far beyond every test
 * budget so termination always comes from the test's own terminate/abort,
 * never from natural exit. Derivation: 60s ≫ it-level timeout 20s.
 */
const SUBPROCESS_HANG_MS = 60_000;

describe('execWithHandle', () => {
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
