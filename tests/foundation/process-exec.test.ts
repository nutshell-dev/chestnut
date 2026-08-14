/**
 * ProcessExec exec tests
 *
 * Covers the exec(command, args, options) entry point:
 * - Direct invocation (no shell)
 * - Args passed verbatim (spaces, quotes, special chars)
 * - Error paths: command not found, non-zero exit, timeout, AbortSignal
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { tmpdir } from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';

import {
  exec,
  execWithHandle,
  kill,
  isAlive,
  findByPattern,
  ProcessExecError,
  ProcessListUnavailable,
  type ExecHandle,
} from '../../src/foundation/process-exec/index.js';
import { isProcessGroupAlive } from '../../src/foundation/process-exec/execution-group.js';
import { DEAD_PID } from '../helpers/dead-pid.js';

/**
 * Subprocess hang duration: 1 minute, >>> any test timeout, force kill expected.
 * Derivation: self-describing (60_000 = 60 sec); large enough that test timeout always fires first.
 */
const SUBPROC_HANG_MS = 60_000;

/**
 * Mid-flight abort schedule (phase 1269 Step C tests): lets the child finish
 * spawn/startup and print its leader/descendant markers, still far earlier
 * than the natural 30s/SUBPROC_HANG exit — the abort always lands mid-flight.
 * Derivation: 200ms ≫ realistic sh/node startup, ≪ 30_000ms natural exit;
 * ≥ __testMinTimeoutMs clamps used below so racing timeouts can also fire.
 */
const ABORT_AFTER_START_MS = 200;

/**
 * Subprocess short sleep: below MIN timeout clamp (1000ms), so the test exec returns success.
 * Derivation: 100ms < PROCESS_EXEC_TIMEOUT_MIN_MS=1000ms → exec finishes before clamp deadline.
 */
const SUBPROC_SHORT_SLEEP_MS = 100;

describe('ProcessExec exec', () => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const workDir = tmpdir();

  // ── basic execution ─────────────────────────────────────────────────────

  it.concurrent('should execute command with args', async () => {
    const result = await exec('echo', ['hello', 'world'], { cwd: workDir });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('hello world');
  });

  it.concurrent('should return empty output on success', async () => {
    const result = await exec('echo', ['ok'], { cwd: workDir });
    expect(result.output.trim()).toBe('ok');
  });

  // ── args are verbatim (no shell interpretation) ─────────────────────────

  it.concurrent('should pass args with spaces without shell splitting', async () => {
    // With shell: echo "hello world" → hello world
    // Without shell: args=['hello world'] → single arg passed to echo
    const result = await exec('echo', ['hello world'], { cwd: workDir });
    expect(result.output.trim()).toBe('hello world');
  });

  it.concurrent('should pass args with special chars verbatim', async () => {
    const result = await exec('echo', ['$', 'HOME', '|', 'grep'], { cwd: workDir });
    // No shell expansion: $ stays literal, | stays literal
    expect(result.output.trim()).toBe('$ HOME | grep');
  });

  it.concurrent('should pass args with single quotes verbatim', async () => {
    const result = await exec('echo', ["it's a test"], { cwd: workDir });
    expect(result.output.trim()).toBe("it's a test");
  });

  // ── contrast with exec (shell) ──────────────────────────────────────────

  it.concurrent('exec does not expand $VAR, sh -c does', async () => {
    const direct = await exec('echo', ['$HOME'], { cwd: workDir });
    expect(direct.output.trim()).toBe('$HOME');

    const shell = await exec('sh', ['-c', 'echo $HOME'], { cwd: workDir });
    expect(shell.output.trim()).not.toBe('$HOME');
  });

  // ── error paths ─────────────────────────────────────────────────────────

  it.concurrent('should throw ProcessExecError on non-existent command', async () => {
    try {
      await exec('nonexistent_command_xyz_12345', [], { cwd: workDir });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      const error = err as ProcessExecError;
      // phase 1269 Step C (反向 5): spawn ENOENT is an OS spawn error, not a
      // termination event — no termination facts, not reported as killed.
      expect(error.termination).toBeUndefined();
      expect(error.killed).toBe(false);
    }
  });

  it.concurrent('should throw ProcessExecError on non-zero exit code', async () => {
    try {
      await exec('node', ['-e', 'process.exit(42)'], { cwd: workDir });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      // phase 1269 Step C (反向 5): plain exit 1/42 is a command result, not
      // an abort/termination cleanup.
      expect((err as ProcessExecError).exitCode).toBe(42);
      expect((err as ProcessExecError).termination).toBeUndefined();
    }
  });

  it.concurrent('should capture output on non-zero exit', async () => {
    try {
      await exec('node', ['-e', `
        process.stdout.write('out data');
        process.stderr.write('err data');
        process.exit(1);
      `], { cwd: workDir });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      expect((err as ProcessExecError).output).toBe('out dataerr data');
    }
  });

  it.concurrent('should throw ProcessExecError on timeout', async () => {
    // phase 1394: __testMinTimeoutMs/__testSigkillGraceMs 绕过 1000ms 硬常量 / 把单 test
    // wall 从 ~2s 降到 ~0.3s。行为契约 (throws ProcessExecError + killed=true) 不变。
    try {
      await exec('node', ['-e', `setTimeout(() => {}, ${SUBPROC_HANG_MS})`], {
        cwd: workDir,
        timeout: 100,
        __testMinTimeoutMs: 100,
        __testSigkillGraceMs: 100,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      expect((err as ProcessExecError).killed).toBe(true);
    }
  });

  it.concurrent('should throw ProcessExecError when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await exec('echo', ['should-not-run'], { cwd: workDir, signal: controller.signal });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      const error = err as ProcessExecError;
      // phase 1269 Step C: no OS process was ever spawned → explicit
      // not_started fact, and no fabricated identity (反向 3).
      expect(error.termination).toBeDefined();
      expect(error.termination!.status).toBe('gone');
      expect(error.termination!.trigger).toBe('abort');
      expect(error.termination!.reason).toBe('not_started');
      expect(error.termination!.identity).toBeUndefined();
      expect(error.termination!.termSent).toBe(false);
      expect(error.termination!.killSent).toBe(false);
    }
  });

  // ── interleaved stdout+stderr ordering ───────────────────────────────────

  it.concurrent('should merge stdout and stderr into single output', async () => {
    const result = await exec('sh', ['-c', 'echo a; echo b >&2; echo c'], { cwd: workDir });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('a\n');
    expect(result.output).toContain('b\n');
    expect(result.output).toContain('c\n');
  });

  // ── timeout clamping shared with exec ────────────────────────────────────

  it.concurrent('should clamp timeout to MIN (1000ms)', async () => {
    // Requesting 10ms timeout should be clamped to 1000ms minimum
    // A 100ms sleep should succeed under the clamped timeout
    const result = await exec('node', ['-e', `setTimeout(() => {}, ${SUBPROC_SHORT_SLEEP_MS})`], {
      cwd: workDir,
      timeout: 10, // below MIN, will be clamped to 1000
    });
    expect(result.exitCode).toBe(0);
  });

  // ── PATH augmentation shared with exec ───────────────────────────────────

  it.concurrent('should include node bin dir in PATH', async () => {
    const result = await exec('node', ['-e', 'console.log(process.env.PATH)'], {
      cwd: workDir,
    });
    const nodeBinDir = path.dirname(process.execPath);
    expect(result.output).toContain(nodeBinDir);
  });

  // ── timeout precedence over exit code ───────────────────────────────────

  it.concurrent('rejects on timeout even when process exits with code 0', async () => {
    // Child catches SIGTERM and exits 0; exec must still report timeout/killed.
    const script = `process.on('SIGTERM', () => { process.exit(0); }); setTimeout(() => {}, ${SUBPROC_HANG_MS});`;
    try {
      await exec('node', ['-e', script], {
        cwd: workDir,
        timeout: 100,
        __testMinTimeoutMs: 100,
        __testSigkillGraceMs: 100,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      expect((err as ProcessExecError).killed).toBe(true);
    }
  });

  // ── maxBuffer single-chunk truncation ───────────────────────────────────

  it.concurrent('truncates output that exceeds maxBuffer', async () => {
    const maxBuffer = 100;
    // Output a large first chunk (> stream highWaterMark) so it backpressures,
    // then one more byte in a second chunk. maxBuffer is the allowed maximum;
    // the extra byte strictly exceeds it.
    const firstChunkSize = 64 * 1024;
    const script = `process.stdout.write('a'.repeat(${firstChunkSize}), () => process.stdout.write('b'));`;
    try {
      await exec('node', ['-e', script], {
        cwd: workDir,
        maxBuffer,
        timeout: 1000,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      expect((err as ProcessExecError).maxBufferExceeded).toBe(true);
      expect((err as ProcessExecError).output.length).toBeLessThanOrEqual(maxBuffer);
    }
  });

  // ── SIGKILL escalation ──────────────────────────────────────────────────

  it.concurrent('should escalate to SIGKILL when process traps SIGTERM', async () => {
    // A fixed parent timeout cannot prove that Node has installed the trap.
    // Observe READY first, then drive the same typed timeout termination path.
    const handle = execWithHandle(
      'node',
      [
        '-e',
        `process.on('SIGTERM', () => {}); console.log('READY'); setTimeout(() => {}, ${SUBPROC_HANG_MS});`,
      ],
      { cwd: workDir, __testSigkillGraceMs: 100 },
    );
    const result = handle.promise.catch((err: unknown) => err);
    await waitForProcessOutput(handle, /READY/);
    const outcome = await handle.terminate('timeout');
    const error = await result;

    expect(error).toBeInstanceOf(ProcessExecError);
    expect((error as ProcessExecError).killed).toBe(true);
    expect(outcome.killSent).toBe(true);
    expect(outcome.status).toBe('gone');
  });

  // ── env control ─────────────────────────────────────────────────────────

  describe('env control', () => {
    it.concurrent('should use caller-provided env (not inherit process.env)', async () => {
      const result = await exec('node', ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))'], {
        cwd: workDir,
        env: { MY_VAR: 'hello' },
      });
      const keys = JSON.parse(result.output.trim());
      expect(keys).toContain('MY_VAR');
      expect(keys).toContain('PATH'); // always augmented
      // process.env secrets should NOT appear
      expect(keys).not.toContain('HOME');
    });

    it.concurrent('should inherit process.env when env not provided', async () => {
      const result = await exec('node', ['-e', 'console.log(!!process.env.HOME)'], {
        cwd: workDir,
      });
      expect(result.output.trim()).toBe('true');
    });
  });

  // ── settled guard ───────────────────────────────────────────────────────

  it.concurrent('should reject exactly once on spawn error', async () => {
    // Non-existent command triggers error event
    // With settled guard, only one rejection should occur
    let rejectCount = 0;
    try {
      await exec('nonexistent_command_xyz_12345', [], { cwd: workDir });
    } catch {
      rejectCount++;
    }
    expect(rejectCount).toBe(1);
  });
});

/**
 * Phase 1269 Step B — timeout/maxBuffer 真实后代清理回归
 *
 * Before this phase, timeout only signalled the direct shell PID; same-group
 * descendants kept running and held stdout/stderr pipes open. Now every
 * normal exec is an isolated POSIX process group and timeout terminates the
 * whole group (TERM → grace → KILL → bounded confirm).
 */
describe('phase 1269 Step B: exec group descendant cleanup', () => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const workDir = tmpdir();

  it.concurrent('timeout kills shell AND same-group descendant (反向 1: pipe 不得等 30s)', async () => {
    // sh is group leader; `sleep 30` is a same-group descendant holding no
    // extra pipes but keeping the shell (and its pipes) alive via `wait`.
    const started = Date.now();
    let sleepPid: number | undefined;
    const handle = execWithHandle('sh', ['-c', 'sleep 30 & echo SLEEP_PID:$!; wait'], {
      cwd: workDir,
      __testSigkillGraceMs: 100,
    });
    const result = handle.promise.catch((err: unknown) => err);
    sleepPid = Number(await waitForProcessOutput(handle, /SLEEP_PID:(\d+)/));
    const outcome = await handle.terminate('timeout');
    const error = await result;
    expect(error).toBeInstanceOf(ProcessExecError);
    expect((error as ProcessExecError).killed).toBe(true);
    expect(outcome.trigger).toBe('timeout');
    expect(outcome.status).toBe('gone');
    const elapsed = Date.now() - started;
    // Promise must settle shortly after timeout+grace+confirm, NOT after the
    // descendant's natural 30s lifetime.
    expect(elapsed).toBeLessThan(15_000);
    expect(isAlive(sleepPid!)).toBe(false);
  }, 20_000);

  it.concurrent('escalates to SIGKILL for the whole group when leader traps TERM (反向 2)', async () => {
    // Leader node traps SIGTERM and keeps running; its sleep child dies on
    // TERM but the leader survives → group still alive → KILL escalation.
    const script = `
      process.on('SIGTERM', () => {});
      const c = require('child_process').spawn('sleep', ['30']);
      console.log('LEADER:' + process.pid);
      console.log('CHILD:' + c.pid);
      setTimeout(() => {}, ${SUBPROC_HANG_MS});
    `;
    const handle = execWithHandle('node', ['-e', script], {
      cwd: workDir,
      __testSigkillGraceMs: 100,
    });
    const result = handle.promise.catch((err: unknown) => err);
    const leaderPid = handle.identity!.leaderPid;
    const childPid = Number(await waitForProcessOutput(handle, /CHILD:(\d+)/));
    const outcome = await handle.terminate('timeout');
    const error = await result;

    expect(error).toBeInstanceOf(ProcessExecError);
    expect((error as ProcessExecError).killed).toBe(true);
    expect((error as ProcessExecError).output).toContain(`LEADER:${leaderPid}`);
    expect(outcome.trigger).toBe('timeout');
    expect(outcome.termSent).toBe(true);
    expect(outcome.killSent).toBe(true);
    expect(outcome.status).toBe('gone');
    expect(isAlive(leaderPid)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
    expect(isProcessGroupAlive(leaderPid)).toBe(false);
  }, 20_000);
});

describe('kill', () => {
  it.concurrent('silently ignores ESRCH (already gone)', () => {
    expect(() => kill(DEAD_PID, 'TERM')).not.toThrow();
  });
  it.concurrent('sends SIGTERM to live process', async () => {
    const child = spawn('sleep', ['10']);
    expect(child.pid).toBeDefined();
    // phase 385: subscribe to 'exit' event BEFORE kill (race-safe) — event-driven
    // 替 vi.waitFor polling，与 phase 370-376 cluster 同模式
    const exitedP = new Promise<void>(resolve => child.once('exit', () => resolve()));
    kill(child.pid!, 'TERM');
    await exitedP;
    expect(isAlive(child.pid!)).toBe(false);
  });
});

describe('isAlive', () => {
  it.concurrent('returns true for self', () => {
    expect(isAlive(process.pid)).toBe(true);
  });
  it.concurrent('returns false for nonexistent pid', () => {
    expect(isAlive(DEAD_PID)).toBe(false);
  });
});

describe('findByPattern', () => {
  it('returns empty for no match', () => {
    expect(findByPattern('zzz_no_such_process_zzz_xyz')).toEqual([]);
  });
  it('finds processes with command field', () => {
    const r = findByPattern('node');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]).toHaveProperty('pid');
    expect(r[0]).toHaveProperty('command');
    expect(typeof r[0]!.pid).toBe('number');
    expect(typeof r[0]!.command).toBe('string');
  });
});

/**
 * Phase 1269 Step C — abort 收敛：L1 自己 own AbortSignal，走同一组终止状态机
 */
describe('phase 1269 Step C: exec abort convergence', () => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const workDir = tmpdir();

  it.concurrent('mid-flight abort terminates the group and rejects with trigger=abort facts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    let leaderPid: number | undefined;
    let sleepPid: number | undefined;
    const handle = execWithHandle(
      'sh',
      ['-c', 'echo LEADER:$$; sleep 30 & echo SLEEP_PID:$!; wait'],
      { cwd: workDir, signal: controller.signal },
    );
    const result = handle.promise.catch((err: unknown) => err);
    sleepPid = Number(await waitForProcessOutput(handle, /SLEEP_PID:(\d+)/));
    controller.abort();
    const error = await result;
    expect(error).toBeInstanceOf(ProcessExecError);
    expect((error as ProcessExecError).termination).toBeDefined();
    expect((error as ProcessExecError).termination!.trigger).toBe('abort');
    expect((error as ProcessExecError).termination!.status).toBe('gone');
    expect((error as ProcessExecError).termination!.termSent).toBe(true);
    expect((error as ProcessExecError).termination!.identity).toBeDefined();
    leaderPid = (error as ProcessExecError).termination!.identity!.leaderPid;
    const elapsed = Date.now() - started;
    // Settles after abort + bounded cleanup, never after the natural 30s.
    expect(elapsed).toBeLessThan(15_000);
    expect(isAlive(leaderPid!)).toBe(false);
    expect(isAlive(sleepPid!)).toBe(false);
  }, 20_000);

  it.concurrent('abort on SIGTERM-ignoring process must not settle before KILL/liveness conclusion (反向 1)', async () => {
    const controller = new AbortController();
    const GRACE_MS = 300;
    const handle = execWithHandle(
      'node',
      [
        '-e',
        `process.on('SIGTERM', () => {}); console.log('READY'); setTimeout(() => {}, ${SUBPROC_HANG_MS})`,
      ],
      { cwd: workDir, signal: controller.signal, __testSigkillGraceMs: GRACE_MS },
    );
    const result = handle.promise.catch((err: unknown) => err);
    await waitForProcessOutput(handle, /READY/);
    const terminationStartedAt = Date.now();
    controller.abort();
    const error = await result;

    expect(error).toBeInstanceOf(ProcessExecError);
    // The promise must NOT settle at abort time with a premature AbortError:
    // escalation ran its full course and the facts say so.
    expect((error as ProcessExecError).termination!.trigger).toBe('abort');
    expect((error as ProcessExecError).termination!.killSent).toBe(true);
    expect((error as ProcessExecError).termination!.status).toBe('gone');
    expect(isAlive(handle.identity!.leaderPid)).toBe(false);

    const elapsed = Date.now() - terminationStartedAt;
    // Timing starts only after READY; child startup scheduling is not part of
    // the TERM grace contract under test.
    expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS);
  }, 20_000);

  it.concurrent('abort and timeout racing do not produce a second TERM sequence nor rewrite the first trigger (反向 2)', async () => {
    const controller = new AbortController();
    const killSpy = vi.spyOn(process, 'kill');
    let leaderPid: number | undefined;
    let firstTrigger: string | undefined;
    try {
      const p = exec('node', ['-e', `setTimeout(() => {}, ${SUBPROC_HANG_MS})`], {
        cwd: workDir,
        signal: controller.signal,
        // Race point: the exec timeout fires at the same moment as the abort
        // schedule below (single semantic source — no numeric drift).
        timeout: ABORT_AFTER_START_MS,
        __testMinTimeoutMs: 100,
        __testSigkillGraceMs: 100,
      });
      // Fire abort at the same moment the timeout fires.
      setTimeout(() => controller.abort(), ABORT_AFTER_START_MS);
      await p;
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      const error = err as ProcessExecError;
      firstTrigger = error.termination!.trigger;
      expect(['timeout', 'abort']).toContain(firstTrigger);
      leaderPid = error.termination!.identity!.leaderPid;
    }
    const groupTerms = killSpy.mock.calls.filter(
      ([pid, sig]) => pid === -leaderPid! && sig === 'SIGTERM',
    );
    expect(groupTerms).toHaveLength(1);
    killSpy.mockRestore();
  }, 20_000);
});

/**
 * Observe a real child readiness fact before triggering termination.
 * Returning capture group 1 keeps PID parsing and readiness as one barrier.
 */
function waitForProcessOutput(handle: ExecHandle, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const stdout = handle.child.stdout;
    if (!stdout) {
      reject(new Error(`child stdout unavailable while waiting for ${String(pattern)}`));
      return;
    }

    const cleanup = () => {
      stdout.off('data', onData);
      handle.child.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = output.match(pattern);
      if (!match) return;
      cleanup();
      resolve(match[1] ?? match[0]);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`child closed before output matched ${String(pattern)}: ${output}`));
    };

    stdout.on('data', onData);
    handle.child.once('close', onClose);
  });
}
