/**
 * Phase 769 — L1 ProcessExec execWithHandle tests
 *
 * Verifies that execWithHandle returns both a promise and an immediately
 * available ChildProcess handle, preserving all existing exec semantics.
 */

import { describe, it, expect, vi } from 'vitest';
import { execWithHandle, ProcessExecError, isProcessGroupAlive } from '../../../src/foundation/process-exec/index.js';
import * as os from 'os';

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
    const killSpy = vi.spyOn(process, 'kill');
    const handle = execWithHandle(
      'node',
      ['-e', `process.on('SIGTERM', () => {}); console.log('READY'); setTimeout(() => {}, 60000)`],
      { cwd: workDir, __testSigkillGraceMs: 100 },
    );
    const pgid = handle.identity!.processGroupId;
    // Wait until the SIGTERM trap is installed; terminating before node
    // boots would hit the default TERM action instead of the escalation path.
    await waitForMatch(handle, /READY/);
    const p1 = handle.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50)); // mid-grace
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
