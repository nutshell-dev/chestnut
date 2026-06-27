/**
 * Phase 769 — L1 ProcessExec execWithHandle tests
 *
 * Verifies that execWithHandle returns both a promise and an immediately
 * available ChildProcess handle, preserving all existing exec semantics.
 */

import { describe, it, expect } from 'vitest';
import { execWithHandle, ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import * as os from 'os';

describe('execWithHandle', () => {
  it('should resolve with output for successful command', async () => {
    const handle = execWithHandle('sh', ['-c', 'echo hello'], {
      cwd: os.tmpdir(),
    });
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('hello');
  });

  it('should expose child process immediately after call', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], {
      cwd: os.tmpdir(),
    });
    expect(handle.child).toBeDefined();
    expect(handle.child.pid).toBeGreaterThan(0);
    handle.child.kill('SIGKILL');
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);
  });

  it('should reject ProcessExecError for non-zero exit', async () => {
    const handle = execWithHandle('sh', ['-c', 'exit 7'], {
      cwd: os.tmpdir(),
    });
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);
    await expect(handle.promise).rejects.toMatchObject({
      exitCode: 7,
    });
  });

  it('should reject ProcessExecError on timeout', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], {
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
      cwd: os.tmpdir(),
      stdin: 'piped content',
    });
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('piped content');
  });

  it('should allow caller to kill child before completion', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], {
      cwd: os.tmpdir(),
    });
    expect(handle.child.pid).toBeGreaterThan(0);
    handle.child.kill('SIGTERM');
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);
  });

  it('should work with __testMinTimeoutMs for fast tests', async () => {
    const handle = execWithHandle('sh', ['-c', 'sleep 10'], {
      cwd: os.tmpdir(),
      timeout: 5,
      __testMinTimeoutMs: 1,
      __testSigkillGraceMs: 50,
    });
    await expect(handle.promise).rejects.toBeInstanceOf(ProcessExecError);
  });
});
