import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import {
  beginRetentionScope,
  RETENTION_RECORD_FILENAME,
  type RetentionScope,
} from './resource-retention.js';

/** Test-infrastructure budget for confirming exit/stdio after termination. */
export const DEFAULT_TEST_CHILD_EXIT_CONFIRM_MS = 1_000;

export interface RunChildProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  killGraceMs?: number;
  exitConfirmMs?: number;
  signal?: AbortSignal;
}

export type ChildProcessFailureReason = 'timeout' | 'cancelled' | 'spawn_error';
export type ExitEvidence = {
  state: 'exited';
  status: number | null;
  signal: NodeJS.Signals | null;
} | { state: 'unconfirmed' };
export type StdioEvidence = 'closed' | 'detached';

export interface ChildProcessResult {
  command: string;
  args: string[];
  pid?: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  /** All process/stdin errors observed before settlement, including EPIPE. */
  errors: Error[];
  directChild: ExitEvidence;
  stdio: StdioEvidence;
  outputTruncated: boolean;
  outputTruncatedAt: string | null;
}

export interface ChildProcessKillAttempt {
  signal: NodeJS.Signals;
  sent: boolean;
  error?: unknown;
}

export type ChildProcessResourceEvidence =
  | { state: 'recorded'; path: string }
  | { state: 'failed'; path: string }
  | { state: 'not_configured' }
  | { state: 'not_required'; reason: 'exit_confirmed' | 'pid_unavailable' };

export interface ChildProcessFailureDetails extends ChildProcessResult {
  reason: ChildProcessFailureReason;
  timeoutMs: number;
  killGraceMs: number;
  exitConfirmMs: number;
  /** Successful requests retained for compatibility with the 2215 helper. */
  killSignals: NodeJS.Signals[];
  killAttempts: ChildProcessKillAttempt[];
  killError?: unknown;
  killErrors: unknown[];
  /** Compatibility alias for stdio. */
  cleanup: StdioEvidence;
  resourceEvidence: ChildProcessResourceEvidence;
}

export interface ChildProcessTimeoutDetails extends ChildProcessFailureDetails {
  reason: 'timeout';
}

export class ChildProcessLifecycleError extends Error {
  readonly code: string;

  constructor(readonly details: ChildProcessFailureDetails, cause: Error) {
    const command = [details.command, ...details.args]
      .map(part => JSON.stringify(part))
      .join(' ');
    const summary = details.reason === 'timeout' ? 'timed out' : details.reason;
    super(
      `Child process ${summary}: command=${command} pid=${details.pid ?? 'unknown'} ` +
      `timeoutMs=${details.timeoutMs} killSignals=${details.killSignals.join(',') || 'none'} ` +
      `status=${details.status ?? 'null'} signal=${details.signal ?? 'null'} ` +
      `directChild=${details.directChild.state} stdio=${details.stdio} ` +
      `outputTruncated=${details.outputTruncated} cleanup=${details.cleanup}`,
      { cause },
    );
    this.name = 'ChildProcessLifecycleError';
    this.code = details.reason === 'cancelled' ? 'ABORT_ERR' : 'ERR_CHILD_PROCESS';
  }
}

export class ChildProcessTimeoutError extends ChildProcessLifecycleError {
  readonly code = 'ETIMEDOUT';

  constructor(readonly details: ChildProcessTimeoutDetails, cause: Error) {
    super(details, cause);
    this.name = 'ChildProcessTimeoutError';
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isBrokenPipe(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'EPIPE';
}

function timeoutCause(command: string, args: string[]): Error {
  return Object.assign(
    new Error(`spawn ${command} ETIMEDOUT`),
    {
      code: 'ETIMEDOUT',
      syscall: 'spawn',
      path: command,
      spawnargs: args,
    },
  );
}

function cancellationCause(signal: AbortSignal): Error {
  if (signal.reason !== undefined) return asError(signal.reason);
  return Object.assign(new Error('Child process cancelled'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

function initialFailureDetails(
  command: string,
  args: string[],
  options: RunChildProcessOptions,
  reason: ChildProcessFailureReason,
  error?: Error,
): ChildProcessFailureDetails {
  return {
    command,
    args,
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    error,
    errors: error ? [error] : [],
    directChild: { state: 'unconfirmed' },
    stdio: 'closed',
    outputTruncated: false,
    outputTruncatedAt: null,
    reason,
    timeoutMs: options.timeoutMs,
    killGraceMs: options.killGraceMs ?? 1_000,
    exitConfirmMs: options.exitConfirmMs ?? DEFAULT_TEST_CHILD_EXIT_CONFIRM_MS,
    killSignals: [],
    killAttempts: [],
    killErrors: [],
    cleanup: 'closed',
    resourceEvidence: { state: 'not_required', reason: 'pid_unavailable' },
  };
}

function lifecycleError(details: ChildProcessFailureDetails, cause: Error): ChildProcessLifecycleError {
  if (details.reason === 'timeout') {
    return new ChildProcessTimeoutError({ ...details, reason: 'timeout' }, cause);
  }
  return new ChildProcessLifecycleError(details, cause);
}

function canonicalForComparison(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function isWithinRunRoot(runRoot: string, candidate: string): boolean {
  const relative = path.relative(
    canonicalForComparison(runRoot),
    canonicalForComparison(candidate),
  );
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function ignoreLateError(): void {
  // A detached stream can still report an asynchronous error after settlement.
}

/**
 * Run a test-owned direct child with bounded execution and termination waits.
 * Descendants are never signalled; detaching stdio explicitly truncates output.
 */
export async function runChildProcess(
  command: string,
  args: string[],
  options: RunChildProcessOptions,
): Promise<ChildProcessResult> {
  if (options.signal?.aborted) {
    throw lifecycleError(
      initialFailureDetails(command, args, options, 'cancelled'),
      cancellationCause(options.signal),
    );
  }

  const runRoot = process.env.CHESTNUT_RUN_ROOT;
  let retention: RetentionScope | undefined;
  if (runRoot) {
    try {
      retention = beginRetentionScope({
        runRoot,
        protectedPaths: options.cwd && isWithinRunRoot(runRoot, options.cwd) ? [options.cwd] : [],
        label: `direct-child:${command}`,
      });
    } catch (error) {
      throw new Error(`Cannot begin direct-child retention before spawn: ${command}`, { cause: error });
    }
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    });
  } catch (error) {
    const processError = asError(error);
    const primary = lifecycleError(
      initialFailureDetails(command, args, options, 'spawn_error', processError),
      processError,
    );
    try {
      retention?.complete();
    } catch (recording) {
      throw new AggregateError(
        [primary, recording],
        'Child process and retention completion both failed',
        { cause: primary },
      );
    }
    throw primary;
  }

  return new Promise<ChildProcessResult>((resolve, reject) => {
    const pid = child.pid;
    const killGraceMs = options.killGraceMs ?? 1_000;
    const exitConfirmMs = options.exitConfirmMs ?? DEFAULT_TEST_CHILD_EXIT_CONFIRM_MS;
    let stdout = '';
    let stderr = '';
    let status: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let directChild: ExitEvidence = { state: 'unconfirmed' };
    let stdio: StdioEvidence = 'closed';
    let outputTruncated = false;
    let outputTruncatedAt: string | null = null;
    let processError: Error | undefined;
    let inputError: Error | undefined;
    const errors: Error[] = [];
    const killSignals: NodeJS.Signals[] = [];
    const killAttempts: ChildProcessKillAttempt[] = [];
    const killErrors: unknown[] = [];
    let killError: unknown;
    let reason: ChildProcessFailureReason | undefined;
    let firstCause: Error | undefined;
    let settled = false;
    let closed = false;
    let executionTimer: NodeJS.Timeout | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    let confirmationTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (executionTimer) clearTimeout(executionTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (confirmationTimer) clearTimeout(confirmationTimer);
    };
    const removeAbortListener = (): void => {
      options.signal?.removeEventListener('abort', onAbort);
    };
    const cleanupListeners = (detached: boolean): void => {
      child.off('exit', onExit);
      child.off('close', onClose);
      child.off('error', onProcessError);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.stdin.off('error', onInputError);
      if (detached) {
        child.on('error', ignoreLateError);
        child.stdin.on('error', ignoreLateError);
        child.stdout.on('error', ignoreLateError);
        child.stderr.on('error', ignoreLateError);
      }
    };
    const result = (): ChildProcessResult => ({
      command,
      args,
      pid,
      status,
      signal: exitSignal,
      stdout,
      stderr,
      error: processError ?? inputError,
      errors: [...errors],
      directChild,
      stdio,
      outputTruncated,
      outputTruncatedAt,
    });
    const requestKill = (signal: NodeJS.Signals): void => {
      try {
        const sent = child.kill(signal);
        killAttempts.push({ signal, sent });
        if (sent) killSignals.push(signal);
      } catch (error) {
        killAttempts.push({ signal, sent: false, error });
        killErrors.push(error);
        killError = error;
      }
    };
    const detachStdio = (): unknown[] => {
      const cleanupErrors: unknown[] = [];
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try {
          stream.destroy();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      return cleanupErrors;
    };
    const recordResourceEvidence = (
      details: ChildProcessFailureDetails,
      additionalErrors: unknown[],
    ): void => {
      const evidencePath = runRoot ? path.join(runRoot, RETENTION_RECORD_FILENAME) : undefined;
      if (details.directChild.state === 'exited' || details.pid === undefined) {
        details.resourceEvidence = details.directChild.state === 'exited'
          ? { state: 'not_required', reason: 'exit_confirmed' }
          : { state: 'not_required', reason: 'pid_unavailable' };
        try {
          retention?.complete();
        } catch (error) {
          if (evidencePath) details.resourceEvidence = { state: 'failed', path: evidencePath };
          additionalErrors.push(error);
        }
        return;
      }
      if (!retention || !evidencePath) {
        details.resourceEvidence = { state: 'not_configured' };
        return;
      }
      try {
        retention.retain({
          code: 'unconfirmed_direct_child',
          error: firstCause,
          evidence: {
            invocationId: process.env.CHESTNUT_INVOCATION_ID,
            command: details.command,
            args: details.args,
            pid: details.pid,
            reason: details.reason,
            timeoutMs: details.timeoutMs,
            killGraceMs: details.killGraceMs,
            exitConfirmMs: details.exitConfirmMs,
            status: details.status,
            signal: details.signal,
            directChild: details.directChild,
            stdio: details.stdio,
            outputTruncated: details.outputTruncated,
            outputTruncatedAt: details.outputTruncatedAt,
            killAttempts: details.killAttempts,
            killErrors: details.killErrors,
            errors: details.errors,
          },
        });
        details.resourceEvidence = { state: 'recorded', path: evidencePath };
      } catch (error) {
        details.resourceEvidence = { state: 'failed', path: evidencePath };
        additionalErrors.push(error);
      }
    };

    const finalizeFailure = (cleanupErrors: unknown[] = []): void => {
      if (settled || !reason || !firstCause) return;
      settled = true;
      clearTimers();
      removeAbortListener();
      const current = result();
      const details: ChildProcessFailureDetails = {
        ...current,
        reason,
        timeoutMs: options.timeoutMs,
        killGraceMs,
        exitConfirmMs,
        killSignals: [...killSignals],
        killAttempts: [...killAttempts],
        killError,
        killErrors: [...killErrors],
        cleanup: stdio,
        resourceEvidence: directChild.state === 'exited'
          ? { state: 'not_required', reason: 'exit_confirmed' }
          : { state: 'not_required', reason: 'pid_unavailable' },
      };
      const additionalErrors = [...cleanupErrors];
      recordResourceEvidence(details, additionalErrors);
      cleanupListeners(stdio === 'detached');
      const primary = lifecycleError(details, firstCause);
      if (additionalErrors.length > 0) {
        reject(new AggregateError(
          [primary, ...additionalErrors],
          'Child process failed and cleanup/evidence recording also failed',
          { cause: primary },
        ));
      } else {
        reject(primary);
      }
    };
    const settleClose = (): void => {
      if (settled) return;
      if (reason) {
        finalizeFailure();
        return;
      }
      settled = true;
      clearTimers();
      removeAbortListener();
      cleanupListeners(false);
      try {
        retention?.complete();
      } catch (error) {
        reject(error);
        return;
      }
      resolve(result());
    };
    const startConfirmation = (): void => {
      if (settled || closed || confirmationTimer !== undefined) return;
      confirmationTimer = setTimeout(() => {
        stdio = 'detached';
        outputTruncated = true;
        outputTruncatedAt = new Date().toISOString();
        const cleanupErrors = detachStdio();
        finalizeFailure(cleanupErrors);
      }, exitConfirmMs);
    };
    const beginTermination = (nextReason: ChildProcessFailureReason, cause: Error): void => {
      if (settled || reason) return;
      reason = nextReason;
      firstCause = cause;
      if (executionTimer) clearTimeout(executionTimer);
      if (nextReason === 'spawn_error' || directChild.state === 'exited') {
        startConfirmation();
        return;
      }
      requestKill('SIGTERM');
      escalationTimer = setTimeout(() => {
        if (directChild.state === 'unconfirmed') requestKill('SIGKILL');
        startConfirmation();
      }, killGraceMs);
    };
    const onExit = (exitStatus: number | null, signal: NodeJS.Signals | null): void => {
      status = exitStatus;
      exitSignal = signal;
      directChild = { state: 'exited', status: exitStatus, signal };
      if (reason) {
        if (escalationTimer) clearTimeout(escalationTimer);
        startConfirmation();
      }
    };
    const onClose = (closeStatus: number | null, signal: NodeJS.Signals | null): void => {
      closed = true;
      if (directChild.state === 'unconfirmed' && pid !== undefined) {
        status = closeStatus;
        exitSignal = signal;
        directChild = { state: 'exited', status: closeStatus, signal };
      }
      settleClose();
    };
    const onProcessError = (error: Error): void => {
      errors.push(error);
      if (!processError) processError = error;
      if (!reason && pid === undefined && directChild.state === 'unconfirmed') {
        beginTermination('spawn_error', error);
      }
    };
    const onInputError = (error: Error): void => {
      // EPIPE remains in errors as early-rejected input evidence. Keep the
      // legacy result.error projection unchanged for existing early-exit CLIs.
      errors.push(error);
      if (!inputError && !isBrokenPipe(error)) inputError = error;
    };
    const onStdout = (chunk: string): void => { stdout += chunk; };
    const onStderr = (chunk: string): void => { stderr += chunk; };
    const onAbort = (): void => {
      if (options.signal) beginTermination('cancelled', cancellationCause(options.signal));
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', onProcessError);
    child.stdin.on('error', onInputError);
    child.on('exit', onExit);
    child.on('close', onClose);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    executionTimer = setTimeout(() => {
      beginTermination('timeout', timeoutCause(command, args));
    }, options.timeoutMs);
    if (options.signal?.aborted) onAbort();
    try {
      child.stdin.end(options.input);
    } catch (error) {
      onInputError(asError(error));
    }
  });
}

function containsUnconfirmedChild(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof ChildProcessLifecycleError &&
      value.details.pid !== undefined && value.details.directChild.state === 'unconfirmed') {
    return true;
  }
  if (value instanceof AggregateError &&
      value.errors.some(error => containsUnconfirmedChild(error, seen))) {
    return true;
  }
  return value instanceof Error && containsUnconfirmedChild(value.cause, seen);
}

/**
 * Await cleanup and retain both failures. A caller-owned fixture remains in
 * place when any started direct child has not confirmed exit; cleanup must not
 * destroy evidence still used by that child. No finally return swallows the
 * original result or failure.
 */
export async function withCleanupPreservingError<T>(
  run: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let failed = false;
  let failure: unknown;
  try {
    return await run();
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    if (!failed || !containsUnconfirmedChild(failure)) {
      try {
        await cleanup();
      } catch (cleanupError) {
        if (failed) {
          throw new AggregateError(
            [failure, cleanupError],
            'Test and cleanup both failed; original test failure is the cause',
            { cause: failure },
          );
        }
        throw asError(cleanupError);
      }
    }
  }
}
