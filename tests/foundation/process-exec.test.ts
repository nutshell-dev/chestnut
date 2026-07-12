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

import { exec, kill, isAlive, findByPattern } from '../../src/foundation/process-exec/index.js';
import { ProcessExecError, ProcessListUnavailable } from '../../src/foundation/process-exec/index.js';
import { KillEscalator } from '../../src/foundation/process-exec/exec.js';
import { DEAD_PID } from '../helpers/dead-pid.js';

/**
 * Subprocess hang duration: 1 minute, >>> any test timeout, force kill expected.
 * Derivation: self-describing (60_000 = 60 sec); large enough that test timeout always fires first.
 */
const SUBPROC_HANG_MS = 60_000;

/**
 * Subprocess short sleep: below MIN timeout clamp (1000ms), so the test exec returns success.
 * Derivation: 100ms < PROCESS_EXEC_TIMEOUT_MIN_MS=1000ms → exec finishes before clamp deadline.
 */
const SUBPROC_SHORT_SLEEP_MS = 100;

describe('ProcessExec exec', () => {
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
    await expect(
      exec('nonexistent_command_xyz_12345', [], { cwd: workDir }),
    ).rejects.toThrow(ProcessExecError);
  });

  it.concurrent('should throw ProcessExecError on non-zero exit code', async () => {
    try {
      await exec('node', ['-e', 'process.exit(42)'], { cwd: workDir });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      expect((err as ProcessExecError).exitCode).toBe(42);
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

    await expect(
      exec('echo', ['should-not-run'], { cwd: workDir, signal: controller.signal }),
    ).rejects.toThrow();
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
    // Node script that ignores SIGTERM, only SIGKILL can stop it
    const script = `process.on('SIGTERM', () => {}); setTimeout(() => {}, ${SUBPROC_HANG_MS});`;

    // phase 1394: 短常数 100ms 让 SIGKILL 升级真路径触发但 wall 从 ~2s 降到 ~0.3s
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

describe('KillEscalator', () => {
  it('arm() cancels previous timer before setting new one', async () => {
    const child = spawn('node', ['-e', `setTimeout(() => {}, ${SUBPROC_HANG_MS})`]);
    const killSpy = vi.spyOn(child, 'kill');

    const escalator = new KillEscalator(child, () => false, 100);
    escalator.arm(); // first timer
    escalator.arm(); // second timer should cancel first

    // Wait past the first timer's original deadline (100ms) plus margin.
    const ESCALATION_WAIT_MS = 150;
    await new Promise((resolve) => setTimeout(resolve, ESCALATION_WAIT_MS));

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith('SIGKILL');

    child.kill('SIGKILL');
  });
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
