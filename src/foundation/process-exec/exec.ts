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
  PROCESS_EXEC_DEFAULT_MAX_BUFFER,
  PROCESS_EXEC_SIGKILL_GRACE_MS,
} from './constants.js';
import type { ExecOptions, ExecResult } from './types.js';
import { ProcessExecError } from './errors.js';

/**
 * Clamp caller-supplied timeout into the supported range.
 * Pure / side-effect free / unit-testable.
 * `minOverride` lets tests bypass the empirical floor (phase 1394).
 */
function clampTimeout(requested: number, minOverride?: number): number {
  const min = minOverride ?? PROCESS_EXEC_TIMEOUT_MIN_MS;
  return Math.min(
    Math.max(requested, min),
    PROCESS_EXEC_TIMEOUT_MAX_MS,
  );
}

/**
 * Build the child process env:
 * - If caller passed options.env, only those vars + PATH are exposed.
 * - If absent, the parent's process.env is inherited.
 * In both cases, PATH is augmented with the current Node bin directory so
 * exec'd scripts can find `node` without relying on caller's PATH layout.
 * Pure (no mutation of caller-provided objects).
 */
function buildChildEnv(options: ExecOptions): Record<string, string | undefined> {
  const nodeBinDir = path.dirname(process.execPath);
  const baseEnv = options.env ?? { ...process.env };
  const pathEnv = baseEnv.PATH ?? process.env.PATH ?? '';
  const augmentedPath = pathEnv.includes(nodeBinDir)
    ? pathEnv
    : `${nodeBinDir}:${pathEnv}`;
  return { ...baseEnv, PATH: augmentedPath };
}

/**
 * Owns the combined + per-stream output buffers and maxBuffer enforcement.
 * On overflow, the supplied `onOverflow` callback is invoked exactly once
 * (caller delivers SIGTERM and registers the SIGKILL escalator).
 * Subsequent chunks are dropped to bound memory during the grace window
 * (phase 948).
 */
class BufferCollector {
  // Triple-bookkeeping (combined + stdout + stderr) trades ~2× memory for
  // two diagnostic properties simultaneously:
  //   (1) `combined`  preserves stdout/stderr interleaving in causal order
  //       (mirrors the live OS event order — needed for log fidelity).
  //   (2) `stdout`/`stderr` separation lets ProcessExecError surface a clean
  //       stderr field for callers that diagnose failures (phase 1062).
  // Achieving both with a single buffer would require post-hoc demuxing,
  // which is impossible without per-chunk source tags. The 2× memory cost
  // is bounded by `maxBytes` (caller-controlled via ExecOptions.maxBuffer).
  readonly combined: Buffer[] = [];
  readonly stdout: Buffer[] = [];
  readonly stderr: Buffer[] = [];
  private totalSize = 0;
  private overflowed = false;
  constructor(
    private readonly maxBytes: number,
    private readonly onOverflow: () => void,
  ) {}

  pushStdout(chunk: Buffer): void {
    if (this.overflowed) return;
    this.stdout.push(chunk);
    this.appendCombined(chunk);
  }

  pushStderr(chunk: Buffer): void {
    if (this.overflowed) return;
    this.stderr.push(chunk);
    this.appendCombined(chunk);
  }

  get isOverflowed(): boolean {
    return this.overflowed;
  }

  combinedString(): string {
    return Buffer.concat(this.combined).toString('utf-8');
  }

  stderrString(): string {
    return Buffer.concat(this.stderr).toString('utf-8');
  }

  private appendCombined(chunk: Buffer): void {
    this.combined.push(chunk);
    this.totalSize += chunk.length;
    if (this.totalSize > this.maxBytes && !this.overflowed) {
      this.overflowed = true;
      this.onOverflow();
    }
  }
}

/**
 * SIGTERM→SIGKILL escalator. Owner calls `arm()` immediately after issuing
 * SIGTERM; if the process has not exited within `PROCESS_EXEC_SIGKILL_GRACE_MS`,
 * SIGKILL is sent. `disarm()` is idempotent and must be called when settled.
 */
class KillEscalator {
  private timerId: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly proc: ReturnType<typeof spawn>,
    private readonly isSettled: () => boolean,
    private readonly graceMs: number = PROCESS_EXEC_SIGKILL_GRACE_MS,
  ) {}

  arm(): void {
    this.timerId = setTimeout(() => {
      if (!this.isSettled()) {
        this.proc.kill('SIGKILL');
      }
    }, this.graceMs);
  }

  disarm(): void {
    if (this.timerId !== undefined) {
      clearTimeout(this.timerId);
      this.timerId = undefined;
    }
  }
}

/**
 * Internal: run a process with shared cross-cutting concerns.
 * Uses spawn for stdout+stderr interleaved capture (preserves timing order).
 */
async function runProcess(
  file: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const timeout = clampTimeout(options.timeout ?? PROCESS_EXEC_DEFAULT_TIMEOUT_MS, options.__testMinTimeoutMs);
  const maxBuffer = Math.max(1, options.maxBuffer ?? PROCESS_EXEC_DEFAULT_MAX_BUFFER);
  const env = buildChildEnv(options);

  return new Promise((resolve, reject) => {
    const proc = spawn(file, args, {
      cwd: options.cwd,
      signal: options.signal,
      env,
    });

    if (options.stdin !== undefined) {
      // phase 518 (review-round4 Foundation M、crash hazard): 加 stdin 'error' listener
      // 防 child 提前退出致 EPIPE 上升为 uncaughtException。silent: stdin 写失败的
      // 业务影响由后续 proc.on('exit') / 'error' 兜底（exitCode + 错误捕获）。
      proc.stdin.on('error', () => { /* silent: EPIPE 兜底防 uncaughtException、业务层走 exit code */ });
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }

    let timedOut = false;
    let settled = false;
    const isSettled = () => settled;

    const escalator = new KillEscalator(proc, isSettled, options.__testSigkillGraceMs);
    const collector = new BufferCollector(maxBuffer, () => {
      proc.kill(); // SIGTERM
      escalator.arm();
    });

    function settle(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      escalator.disarm();
    }

    proc.stdout?.on('data', (chunk: Buffer) => collector.pushStdout(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => collector.pushStderr(chunk));

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill(); // SIGTERM (default)
      escalator.arm();
    }, timeout);

    proc.on('error', (err) => {
      if (settled) return; // guard: close may arrive first
      settle();
      reject(new ProcessExecError({
        message: err.message,
        output: collector.combinedString(),
        code: (err as NodeJS.ErrnoException).code,
        exitCode: null,
        stderr: collector.stderrString() || undefined,
      }));
    });

    proc.on('close', (code, signal) => {
      if (settled) return;
      settle();

      const output = collector.combinedString();
      const stderr = collector.stderrString() || undefined;

      if (code === 0) {
        resolve({ output, exitCode: 0, stderr });
        return;
      }

      const exitCode = code ?? null;

      if (timedOut) {
        reject(new ProcessExecError({
          message: `Command timed out after ${timeout}ms`,
          output,
          exitCode,
          killed: true,
          stderr,
        }));
        return;
      }

      if (collector.isOverflowed) {
        reject(new ProcessExecError({
          message: `Command output exceeded ${maxBuffer / 1024 / 1024} MB limit`,
          output,
          exitCode,
          maxBufferExceeded: true,
          stderr,
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
        stderr,
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
