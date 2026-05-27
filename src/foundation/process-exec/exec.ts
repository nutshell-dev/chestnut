/**
 * ProcessExec - External process execution (L1)
 *
 * Single entry point: exec(command, args, options) — direct invocation, no shell.
 * Callers may pass 'sh' as the command to run scripts via shell.
 *
 * Shared: timeout clamping, PATH augmentation, maxBuffer protection, ProcessExecError.
 */

import { spawn } from 'child_process';
import * as path from 'path';

import {
  PROCESS_EXEC_TIMEOUT_MIN_MS,
  PROCESS_EXEC_TIMEOUT_MAX_MS,
  PROCESS_EXEC_DEFAULT_TIMEOUT_MS,
} from './types.js';

const PROCESS_EXEC_MAX_BUFFER = 1024 * 1024; // 1MB; internal
/**
 * SIGTERM → SIGKILL escalation grace period (user process)。
 * 1000ms = POSIX 行业 SIGTERM grace period（systemd / kubelet / Docker stack 最小 graceful 单位）。
 * 与 `WATCHDOG_SIGKILL_GRACE_MS = 500` (watchdog/watchdog-cli.ts) 故意值不同：
 *   - EXEC:    1000ms — user process、POSIX 行业
 *   - WATCHDOG: 500ms — watchdog daemon、更快 cleanup
 */
const EXEC_SIGKILL_GRACE_MS = 1000;
import type { ExecOptions, ExecResult } from './types.js';
import { ProcessExecError } from './types.js';

/**
 * Internal: run a process with shared cross-cutting concerns.
 * Uses spawn for stdout+stderr interleaved capture (preserves timing order).
 */
async function runProcess(
  file: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  // Clamp timeout
  const requestedTimeout = options.timeout ?? PROCESS_EXEC_DEFAULT_TIMEOUT_MS;
  const timeout = Math.min(
    Math.max(requestedTimeout, PROCESS_EXEC_TIMEOUT_MIN_MS),
    PROCESS_EXEC_TIMEOUT_MAX_MS,
  );

  // PATH augmentation: ensure Node bin directory is included
  const nodeBinDir = path.dirname(process.execPath);

  // Build child env: caller-provided or inherit process.env
  const baseEnv = options.env ?? { ...process.env };
  const pathEnv = baseEnv.PATH ?? process.env.PATH ?? '';
  const augmentedPath = pathEnv.includes(nodeBinDir)
    ? pathEnv
    : `${nodeBinDir}:${pathEnv}`;

  return new Promise((resolve, reject) => {
    const proc = spawn(file, args, {
      cwd: options.cwd,
      signal: options.signal,
      env: {
        ...baseEnv,
        PATH: augmentedPath,
      },
    });

    if (options.stdin !== undefined) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }

    const buffers: Buffer[] = [];
    const stdoutBuffers: Buffer[] = [];
    const stderrBuffers: Buffer[] = [];
    let totalSize = 0;
    let timedOut = false;
    let maxBufferExceeded = false;
    let settled = false;
    let killTimerId: ReturnType<typeof setTimeout> | undefined;

    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (killTimerId !== undefined) clearTimeout(killTimerId);
    }

    function escalateToKill() {
      if (!settled) {
        proc.kill('SIGKILL');
      }
    }

    function pushChunk(chunk: Buffer) {
      if (maxBufferExceeded) return; // phase 948: SIGTERM 后 grace period 内不再累 buffers（防 memory 浪费）
      buffers.push(chunk);
      totalSize += chunk.length;
      if (totalSize > PROCESS_EXEC_MAX_BUFFER && !maxBufferExceeded) {
        maxBufferExceeded = true;
        proc.kill(); // SIGTERM
        killTimerId = setTimeout(escalateToKill, EXEC_SIGKILL_GRACE_MS);
      }
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffers.push(chunk);
      pushChunk(chunk);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffers.push(chunk);
      pushChunk(chunk);
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill(); // SIGTERM (default)
      killTimerId = setTimeout(escalateToKill, EXEC_SIGKILL_GRACE_MS);
    }, timeout);

    proc.on('error', (err) => {
      if (settled) return; // guard: close may arrive first
      settle();
      const output = Buffer.concat(buffers).toString('utf-8');
      const stderr = Buffer.concat(stderrBuffers).toString('utf-8');
      reject(new ProcessExecError({
        message: err.message,
        output,
        code: (err as NodeJS.ErrnoException).code,
        exitCode: null,
        stderr: stderr || undefined,
      }));
    });

    proc.on('close', (code, signal) => {
      if (settled) return;
      settle();

      const output = Buffer.concat(buffers).toString('utf-8');
      const stderr = Buffer.concat(stderrBuffers).toString('utf-8');

      if (code === 0) {
        resolve({ output, exitCode: 0, stderr: stderr || undefined });
        return;
      }

      const exitCode = code ?? null;

      if (timedOut) {
        reject(new ProcessExecError({
          message: `Command timed out after ${timeout}ms`,
          output,
          exitCode,
          killed: true,
          stderr: stderr || undefined,
        }));
        return;
      }

      if (maxBufferExceeded) {
        reject(new ProcessExecError({
          message: `Command output exceeded ${PROCESS_EXEC_MAX_BUFFER / 1024 / 1024} MB limit`,
          output,
          exitCode,
          maxBufferExceeded: true,
          stderr: stderr || undefined,
        }));
        return;
      }

      reject(new ProcessExecError({
        message: signal
          ? `Command killed with signal ${signal}`
          : `Command failed with exit code ${exitCode}`,
        output,
        exitCode,
        signal: signal ?? undefined,
        killed: !!signal,
        stderr: stderr || undefined,
      }));
    });
  });
}

/**
 * Execute a command with explicit args — no shell string interpolation.
 * L1 ProcessExec 不 own shell 兼容层（应然 §10）/ caller 显式调 'sh' 自负跨 OS 风险。
 */
export async function exec(
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return runProcess(command, args, options);
}
