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
} from './constants.js';
import { terminateExecutionGroup } from './execution-group.js';
import type {
  ExecOptions,
  ExecResult,
  ExecHandle,
  ExecutionIdentity,
  ExecutionTerminationFact,
  ExecutionTerminationOutcome,
  ExecutionTerminationTrigger,
} from './types.js';
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
    this.pushChunk(this.stdout, chunk);
  }

  pushStderr(chunk: Buffer): void {
    if (this.overflowed) return;
    this.pushChunk(this.stderr, chunk);
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

  private pushChunk(stream: Buffer[], chunk: Buffer): void {
    const remaining = this.maxBytes - this.totalSize;
    if (remaining <= 0) {
      if (!this.overflowed) {
        this.overflowed = true;
        this.onOverflow();
      }
      return;
    }
    const toPush = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    stream.push(toPush);
    this.combined.push(toPush);
    this.totalSize += toPush.length;
    if (this.totalSize > this.maxBytes && !this.overflowed) {
      this.overflowed = true;
      this.onOverflow();
    }
  }
}

/**
 * Spawn a process as an isolated POSIX process-group leader and return a
 * handle exposing the settled promise, the live ChildProcess (streams/unref
 * only), the execution identity, and the single idempotent L1-owned
 * terminate() entry point. Callers must not use child.kill — OS signal
 * semantics do not cross module boundaries.
 */
export function execWithHandle(
  command: string,
  args: string[],
  options: ExecOptions,
): ExecHandle {
  // Test-only overrides are honored only under vitest (NODE_ENV === 'test').
  // Production callers are silently degraded to the default constants rather
  // than bypassing the empirical floor or the SIGTERM→SIGKILL grace (F7).
  const testMode = process.env.NODE_ENV === 'test';
  const timeout = clampTimeout(options.timeout ?? PROCESS_EXEC_DEFAULT_TIMEOUT_MS, testMode ? options.__testMinTimeoutMs : undefined);
  const maxBuffer = Math.max(1, options.maxBuffer ?? PROCESS_EXEC_DEFAULT_MAX_BUFFER);
  const env = buildChildEnv(options);

  // Pre-aborted signal: never spawn an OS process. The error is explicit
  // (trigger='abort', status='gone', reason='not_started') and no PID/PGID
  // is fabricated — no execution unit was ever created.
  if (options.signal?.aborted) {
    throw new ProcessExecError({
      message: 'Command not started: abort signal already aborted',
      exitCode: null,
      killed: true,
      termination: {
        status: 'gone',
        trigger: 'abort',
        termSent: false,
        killSent: false,
        reason: 'not_started',
      },
    });
  }

  // detached: true — every normal exec is an isolated POSIX process-group
  // leader (PGID = leader PID), so termination can target the whole group
  // instead of only the direct shell. NOT unref'd: pipe/handle lifetime still
  // binds the child to this process. spawnDetached() daemons are a different
  // resource class and do not reuse this state machine.
  // NOTE: the AbortSignal is deliberately NOT handed to spawn. Node's native
  // signal path settles with a premature AbortError and disarms cleanup while
  // the process may still be alive; L1 owns abort via terminate('abort').
  const proc = spawn(command, args, {
    cwd: options.cwd,
    env,
    detached: true,
  });

  // Never fabricated: absent only when spawn itself failed (no pid assigned).
  const identity: ExecutionIdentity | undefined = proc.pid !== undefined
    ? { leaderPid: proc.pid, processGroupId: proc.pid }
    : undefined;

  if (options.stdin !== undefined) {
    // phase 518 (review-round4 Foundation M、crash hazard): 加 stdin 'error' listener
    // 防 child 提前退出致 EPIPE 上升为 uncaughtException。silent: stdin 写失败的
    // 业务影响由后续 proc.on('exit') / 'error' 兜底（exitCode + 错误捕获）。
    proc.stdin.on('error', () => { /* silent: EPIPE 兜底防 uncaughtException、业务层走 exit code */ });
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }

  // Idempotent termination coordination: the first trigger wins and fixes the
  // earliest SIGKILL deadline; concurrent/repeat calls share one in-flight
  // run and must never reset timers or extend the deadline.
  let terminationPromise: Promise<ExecutionTerminationOutcome> | undefined;
  const terminate = (trigger: ExecutionTerminationTrigger): Promise<ExecutionTerminationOutcome> => {
    if (terminationPromise) return terminationPromise;
    if (identity === undefined) {
      // Spawn failed — no execution unit was ever created, so there is
      // honestly nothing to terminate; the promise rejects via the spawn
      // error path instead.
      terminationPromise = Promise.reject(
        new ProcessExecError({
          message: 'Cannot terminate: process never started',
          exitCode: null,
        }),
      );
      terminationPromise.catch(() => { /* silent: surfaced via promise rejection */ });
      return terminationPromise;
    }
    terminationPromise = terminateExecutionGroup(identity, trigger, {
      graceMs: testMode ? options.__testSigkillGraceMs : undefined,
    });
    return terminationPromise;
  };

  const promise = new Promise<ExecResult>((resolve, reject) => {
    let timedOut = false;
    let settled = false;

    const collector = new BufferCollector(maxBuffer, () => {
      terminate('max_buffer');
    });

    function settle(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onAbort);
    }

    proc.stdout?.on('data', (chunk: Buffer) => collector.pushStdout(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => collector.pushStderr(chunk));

    const timeoutId = setTimeout(() => {
      timedOut = true;
      terminate('timeout');
    }, timeout);

    // Mid-flight abort: the listener only starts the shared termination
    // state machine (first trigger wins); it never rejects directly and
    // never signals the leader PID on its own.
    const onAbort = (): void => {
      terminate('abort');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    // Race: the signal may have aborted between the pre-spawn check and the
    // listener registration; addEventListener does not fire retroactively.
    if (options.signal?.aborted) onAbort();

    proc.on('error', (err) => {
      if (settled) return; // guard: close may arrive first
      if (terminationPromise !== undefined) return; // never preempt an in-flight termination via the error event
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
      // The process lifecycle has ended: the timeout timer must not fire
      // during termination confirmation and overwrite the earliest trigger
      // (e.g. max_buffer at t=40ms must not be reported as timeout at
      // t=1000ms just because cleanup confirmation outlived the timer).
      clearTimeout(timeoutId);

      const output = collector.combinedString();
      const stderr = collector.stderrString() || undefined;

      // A close only speaks about the leader/stdio; it does not by itself
      // prove the group is gone. Once termination has been triggered, the
      // promise settles only after the termination state machine reaches a
      // structured conclusion.
      if (terminationPromise !== undefined) {
        terminationPromise.then(
          (outcome) => {
            if (settled) return;
            settle();

            const termination: ExecutionTerminationFact = {
              status: outcome.status,
              trigger: outcome.trigger,
              termSent: outcome.termSent,
              killSent: outcome.killSent,
              identity: outcome.identity,
              ...(outcome.status === 'indeterminate' ? { reason: outcome.reason } : {}),
            };

            // System termination reasons take precedence over exit code interpretation.
            if (timedOut) {
              reject(new ProcessExecError({
                message: `Command timed out after ${timeout}ms`,
                output,
                exitCode: code ?? null,
                signal: signal ?? undefined,
                killed: true,
                stderr,
                termination,
              }));
              return;
            }

            if (collector.isOverflowed) {
              reject(new ProcessExecError({
                message: `Command output exceeded ${maxBuffer / 1024 / 1024} MB limit`,
                output,
                exitCode: code ?? null,
                signal: signal ?? undefined,
                maxBufferExceeded: true,
                stderr,
                termination,
              }));
              return;
            }

            reject(new ProcessExecError({
              message: `Command terminated (${outcome.trigger}, cleanup: ${outcome.status})` +
                (outcome.status === 'indeterminate' ? `, reason: ${outcome.reason}` : ''),
              output,
              exitCode: code ?? null,
              signal: signal ?? undefined,
              killed: true,
              stderr,
              termination,
            }));
          },
          // Spawn failed and terminate() was called before the error event
          // (abort race / 1s timeout window): the shared termination promise
          // rejected with "Cannot terminate: process never started". Surface
          // that rejection here — the derived promise must have a consumer,
          // otherwise the daemon's unhandledRejection handler exits(1).
          (err: unknown) => {
            if (settled) return;
            settle();
            reject(err instanceof ProcessExecError
              ? err
              : new ProcessExecError({
                  message: `Termination failed: ${String(err)}`,
                  exitCode: null,
                }));
          },
        );
        return;
      }

      settle();

      if (signal) {
        reject(new ProcessExecError({
          message: `Command killed by signal ${signal}`,
          output,
          exitCode: null,
          killed: true,
          stderr,
        }));
        return;
      }

      if (code === 0) {
        resolve({ output, exitCode: 0, stderr });
        return;
      }

      if (proc.killed) {
        reject(new ProcessExecError({
          message: 'Command was killed',
          output,
          exitCode: code,
          killed: true,
          stderr,
        }));
        return;
      }

      reject(new ProcessExecError({
        message: `Command exited with code ${code}`,
        output,
        exitCode: code,
        killed: false,
        stderr,
      }));
    });
  });

  return {
    promise,
    child: proc,
    identity,
    terminate: (trigger?: ExecutionTerminationTrigger) => terminate(trigger ?? 'caller_requested'),
  };
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
  return execWithHandle(command, args, options).promise;
}
