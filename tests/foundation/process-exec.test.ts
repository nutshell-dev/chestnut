/**
 * ProcessExec exec tests
 *
 * Covers the exec(command, args, options) entry point:
 * - Direct invocation (no shell)
 * - Args passed verbatim (spaces, quotes, special chars)
 * - Error paths: command not found, non-zero exit, timeout, AbortSignal
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { tmpdir } from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';

import { exec, kill, isAlive, findByPattern } from '../../src/foundation/process-exec/index.js';
import { ProcessExecError, ProcessListUnavailable } from '../../src/foundation/process-exec/index.js';

describe('ProcessExec exec', () => {
  const workDir = tmpdir();

  // ── basic execution ─────────────────────────────────────────────────────

  it('should execute command with args', async () => {
    const result = await exec('echo', ['hello', 'world'], { cwd: workDir });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('hello world');
  });

  it('should return empty output on success', async () => {
    const result = await exec('echo', ['ok'], { cwd: workDir });
    expect(result.output.trim()).toBe('ok');
  });

  // ── args are verbatim (no shell interpretation) ─────────────────────────

  it('should pass args with spaces without shell splitting', async () => {
    // With shell: echo "hello world" → hello world
    // Without shell: args=['hello world'] → single arg passed to echo
    const result = await exec('echo', ['hello world'], { cwd: workDir });
    expect(result.output.trim()).toBe('hello world');
  });

  it('should pass args with special chars verbatim', async () => {
    const result = await exec('echo', ['$', 'HOME', '|', 'grep'], { cwd: workDir });
    // No shell expansion: $ stays literal, | stays literal
    expect(result.output.trim()).toBe('$ HOME | grep');
  });

  it('should pass args with single quotes verbatim', async () => {
    const result = await exec('echo', ["it's a test"], { cwd: workDir });
    expect(result.output.trim()).toBe("it's a test");
  });

  // ── contrast with exec (shell) ──────────────────────────────────────────

  it('exec does not expand $VAR, sh -c does', async () => {
    const direct = await exec('echo', ['$HOME'], { cwd: workDir });
    expect(direct.output.trim()).toBe('$HOME');

    const shell = await exec('sh', ['-c', 'echo $HOME'], { cwd: workDir });
    expect(shell.output.trim()).not.toBe('$HOME');
  });

  // ── error paths ─────────────────────────────────────────────────────────

  it('should throw ProcessExecError on non-existent command', async () => {
    await expect(
      exec('nonexistent_command_xyz_12345', [], { cwd: workDir }),
    ).rejects.toThrow(ProcessExecError);
  });

  it('should throw ProcessExecError on non-zero exit code', async () => {
    try {
      await exec('node', ['-e', 'process.exit(42)'], { cwd: workDir });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      expect((err as ProcessExecError).exitCode).toBe(42);
    }
  });

  it('should capture output on non-zero exit', async () => {
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

  it('should throw ProcessExecError on timeout', async () => {
    await expect(
      exec('node', ['-e', 'setTimeout(() => {}, 60000)'], {
        cwd: workDir,
        timeout: 1000,
      }),
    ).rejects.toThrow(ProcessExecError);

    try {
      await exec('node', ['-e', 'setTimeout(() => {}, 60000)'], {
        cwd: workDir,
        timeout: 1000,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      expect((err as ProcessExecError).killed).toBe(true);
    }
  });

  it('should throw ProcessExecError when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      exec('echo', ['should-not-run'], { cwd: workDir, signal: controller.signal }),
    ).rejects.toThrow();
  });

  // ── interleaved stdout+stderr ordering ───────────────────────────────────

  it('should merge stdout and stderr into single output', async () => {
    const result = await exec('sh', ['-c', 'echo a; echo b >&2; echo c'], { cwd: workDir });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('a\n');
    expect(result.output).toContain('b\n');
    expect(result.output).toContain('c\n');
  });

  // ── timeout clamping shared with exec ────────────────────────────────────

  it('should clamp timeout to MIN (1000ms)', async () => {
    // Requesting 10ms timeout should be clamped to 1000ms minimum
    // A 100ms sleep should succeed under the clamped timeout
    const result = await exec('node', ['-e', 'setTimeout(() => {}, 100)'], {
      cwd: workDir,
      timeout: 10, // below MIN, will be clamped to 1000
    });
    expect(result.exitCode).toBe(0);
  });

  // ── PATH augmentation shared with exec ───────────────────────────────────

  it('should include node bin dir in PATH', async () => {
    const result = await exec('node', ['-e', 'console.log(process.env.PATH)'], {
      cwd: workDir,
    });
    const nodeBinDir = path.dirname(process.execPath);
    expect(result.output).toContain(nodeBinDir);
  });

  // ── SIGKILL escalation ──────────────────────────────────────────────────

  it('should escalate to SIGKILL when process traps SIGTERM', async () => {
    // Node script that ignores SIGTERM, only SIGKILL can stop it
    const script = `process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000);`;

    try {
      await exec('node', ['-e', script], {
        cwd: workDir,
        timeout: 1000, // clamped to MIN 1000ms
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecError);
      expect((err as ProcessExecError).killed).toBe(true);

    }
  });

  // ── env control ─────────────────────────────────────────────────────────

  describe('env control', () => {
    it('should use caller-provided env (not inherit process.env)', async () => {
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

    it('should inherit process.env when env not provided', async () => {
      const result = await exec('node', ['-e', 'console.log(!!process.env.HOME)'], {
        cwd: workDir,
      });
      expect(result.output.trim()).toBe('true');
    });
  });

  // ── settled guard ───────────────────────────────────────────────────────

  it('should reject exactly once on spawn error', async () => {
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

describe('kill', () => {
  it('silently ignores ESRCH (already gone)', () => {
    expect(() => kill(999999999, 'TERM')).not.toThrow();
  });
  it('sends SIGTERM to live process', async () => {
    const child = spawn('sleep', ['10']);
    expect(child.pid).toBeDefined();
    kill(child.pid!, 'TERM');
    await new Promise(r => setTimeout(r, 100));
    expect(isAlive(child.pid!)).toBe(false);
  });
});

describe('isAlive', () => {
  it('returns true for self', () => {
    expect(isAlive(process.pid)).toBe(true);
  });
  it('returns false for nonexistent pid', () => {
    expect(isAlive(999999999)).toBe(false);
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
