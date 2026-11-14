/**
 * @module L1.ProcessExec
 *
 * Find processes by command pattern (POSIX pgrep + ps).
 */

import { spawn, spawnSync } from 'child_process';
import {
  PROCESS_EXEC_DEFAULT_MAX_BUFFER,
  PROCESS_EXEC_DEFAULT_TIMEOUT_MS,
} from './constants.js';
import {
  ProcessListUnavailable,
  type ProcessListFailureClassification,
  type ProcessListOperation,
} from './errors.js';
import type { ProcessInfo } from './types.js';

export interface FindByPatternOptions {
  /** Bound applied independently to the pgrep and ps child processes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Combined stdout + stderr byte limit for each child process. */
  maxBuffer?: number;
  /** Deterministic test seam; production callers use the L1 child_process owner. */
  spawnProcess?: typeof spawn;
}

interface FailureDetails {
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  code?: string;
}

function unavailable(
  pattern: string,
  operation: ProcessListOperation,
  classification: ProcessListFailureClassification,
  cause: unknown,
  details: FailureDetails = {},
): ProcessListUnavailable {
  return new ProcessListUnavailable(pattern, cause, {
    operation,
    classification,
    status: details.status,
    signal: details.signal,
    stderr: details.stderr,
    code: details.code,
  });
}

function errnoCode(cause: unknown): string | undefined {
  return typeof cause === 'object' && cause !== null && 'code' in cause
    && typeof (cause as NodeJS.ErrnoException).code === 'string'
    ? (cause as NodeJS.ErrnoException).code
    : undefined;
}

function spawnFailureClassification(cause: unknown): ProcessListFailureClassification {
  const code = errnoCode(cause);
  if (code === 'ENOBUFS') return 'max_buffer';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ABORT_ERR') return 'abort';
  return 'spawn_error';
}

function nonzeroExit(
  pattern: string,
  operation: ProcessListOperation,
  status: number | null,
  stderr: string,
  signal: NodeJS.Signals | null = null,
): ProcessListUnavailable {
  const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
  return unavailable(
    pattern,
    operation,
    signal === null ? 'nonzero_exit' : 'signal',
    new Error(`${operation} exit ${String(status)}${suffix}`),
    { status, signal, stderr },
  );
}

function escapeLiteral(pattern: string): string {
  return pattern.replace(/[\\.^$*+?()[\]{}|]/g, '\\$&');
}

function parsePids(stdout: string): number[] {
  return stdout
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => parseInt(s, 10))
    .filter(n => !isNaN(n));
}

function parseProcessList(stdout: string): ProcessInfo[] {
  return stdout.split('\n').filter(l => l.trim().length > 0).map(line => {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) return null;
    return { pid: parseInt(m[1]!, 10), command: m[2]!.trim() };
  }).filter((x): x is ProcessInfo => x !== null);
}

/**
 * Find processes matching pattern. Returns pids + command strings.
 * Synchronous CLI diagnostic API; event-loop-sensitive callers use the
 * bounded async variant.
 *
 * @throws ProcessListUnavailable if either process-list operation fails.
 */
export function findByLiteralPatternSyncForCli(pattern: string): ProcessInfo[] {
  return findByPatternSyncForCli(escapeLiteral(pattern));
}

export function findByPatternSyncForCli(pattern: string): ProcessInfo[] {
  let pids: number[];
  try {
    const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf-8' });
    if (result.error) {
      throw unavailable(pattern, 'pgrep', spawnFailureClassification(result.error), result.error, {
        status: result.status,
        signal: result.signal,
        stderr: result.stderr,
        code: errnoCode(result.error),
      });
    }
    if (result.status === 1) return [];
    if (result.status !== 0) {
      throw nonzeroExit(pattern, 'pgrep', result.status, result.stderr, result.signal);
    }
    pids = parsePids(result.stdout);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) throw err;
    throw unavailable(pattern, 'pgrep', spawnFailureClassification(err), err, { code: errnoCode(err) });
  }

  if (pids.length === 0) return [];

  try {
    const psResult = spawnSync('ps', ['-o', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf-8' });
    if (psResult.error) {
      throw unavailable(pattern, 'ps', spawnFailureClassification(psResult.error), psResult.error, {
        status: psResult.status,
        signal: psResult.signal,
        stderr: psResult.stderr,
        code: errnoCode(psResult.error),
      });
    }
    if (psResult.status !== 0) {
      throw nonzeroExit(pattern, 'ps', psResult.status, psResult.stderr, psResult.signal);
    }
    return parseProcessList(psResult.stdout);
  } catch (err) {
    if (err instanceof ProcessListUnavailable) throw err;
    throw unavailable(pattern, 'ps', spawnFailureClassification(err), err, { code: errnoCode(err) });
  }
}

interface AsyncProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function abortCause(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('Process list query aborted'), { code: 'ABORT_ERR' });
}

function abortFailure(
  pattern: string,
  operation: ProcessListOperation,
  signal: AbortSignal,
  stderr = '',
): ProcessListUnavailable {
  const cause = abortCause(signal);
  return unavailable(pattern, operation, 'abort', cause, {
    stderr,
    code: errnoCode(cause) ?? 'ABORT_ERR',
  });
}

/** Spawn one bounded listing command. The child_process import is the mock seam. */
async function runListingProcess(
  command: ProcessListOperation,
  args: string[],
  pattern: string,
  options: FindByPatternOptions,
): Promise<AsyncProcessResult> {
  const signal = options.signal;
  if (signal?.aborted) throw abortFailure(pattern, command, signal);

  let proc: ReturnType<typeof spawn>;
  try {
    // L1 owns abort/timeout cleanup rather than delegating it to spawn's
    // premature AbortError path.
    proc = (options.spawnProcess ?? spawn)(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw unavailable(pattern, command, spawnFailureClassification(err), err, { code: errnoCode(err) });
  }

  const requestedTimeout = options.timeoutMs ?? PROCESS_EXEC_DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(Math.max(0, requestedTimeout), 2_147_483_647)
    : PROCESS_EXEC_DEFAULT_TIMEOUT_MS;
  const requestedMaxBuffer = options.maxBuffer ?? PROCESS_EXEC_DEFAULT_MAX_BUFFER;
  const maxBuffer = Number.isFinite(requestedMaxBuffer)
    ? Math.max(1, Math.floor(requestedMaxBuffer))
    : PROCESS_EXEC_DEFAULT_MAX_BUFFER;

  return new Promise<AsyncProcessResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let buffered = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stderrString = (): string => Buffer.concat(stderr).toString('utf-8');
    const cleanupTransient = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      proc.stdout?.off('data', onStdout);
      proc.stderr?.off('data', onStderr);
    };
    const cleanupLifecycle = (): void => {
      proc.off('error', onError);
      proc.off('close', onClose);
    };
    const rejectFailure = (error: ProcessListUnavailable): void => {
      if (settled) return;
      settled = true;
      cleanupTransient();
      cleanupLifecycle();
      reject(error);
    };
    const terminate = (error: ProcessListUnavailable): void => {
      if (settled) return;
      settled = true;
      cleanupTransient();
      // Keep error/close handlers until the OS lifecycle event so late error
      // events are consumed and those handlers then remove themselves.
      try {
        proc.kill('SIGKILL');
      } catch {
        // silent: the typed timeout/abort/overflow evidence remains the primary fact.
      }
      reject(error);
    };
    const push = (target: Buffer[], chunk: Buffer | string): boolean => {
      if (settled) return false;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxBuffer - buffered);
      target.push(buffer.subarray(0, remaining));
      buffered += Math.min(buffer.length, remaining);
      if (buffer.length > remaining) {
        const cause = Object.assign(
          new Error(`${command} output exceeded ${maxBuffer} bytes`),
          { code: 'ENOBUFS' },
        );
        terminate(unavailable(pattern, command, 'max_buffer', cause, {
          stderr: stderrString(),
          code: 'ENOBUFS',
        }));
        return false;
      }
      return true;
    };
    function onStdout(chunk: Buffer | string): void {
      push(stdout, chunk);
    }
    function onStderr(chunk: Buffer | string): void {
      push(stderr, chunk);
    }
    function onAbort(): void {
      terminate(abortFailure(pattern, command, signal!, stderrString()));
    }
    function onError(err: Error): void {
      if (settled) {
        cleanupLifecycle();
        return;
      }
      rejectFailure(unavailable(pattern, command, spawnFailureClassification(err), err, {
        stderr: stderrString(),
        code: errnoCode(err),
      }));
    }
    function onClose(status: number | null, processSignal: NodeJS.Signals | null): void {
      cleanupLifecycle();
      if (settled) return;
      if (processSignal !== null) {
        rejectFailure(unavailable(
          pattern,
          command,
          'signal',
          new Error(`${command} killed by signal ${processSignal}`),
          { status, signal: processSignal, stderr: stderrString() },
        ));
        return;
      }
      settled = true;
      cleanupTransient();
      resolve({ status, stdout: Buffer.concat(stdout).toString('utf-8'), stderr: stderrString() });
    }

    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.on('error', onError);
    proc.on('close', onClose);
    timer = setTimeout(() => {
      const cause = Object.assign(
        new Error(`${command} timed out after ${timeoutMs}ms`),
        { code: 'ETIMEDOUT' },
      );
      terminate(unavailable(pattern, command, 'timeout', cause, {
        stderr: stderrString(),
        code: 'ETIMEDOUT',
      }));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Close the pre-check/listener-registration race without spawning again.
    if (signal?.aborted) onAbort();
  });
}

export async function findByLiteralPatternAsync(
  pattern: string,
  options: FindByPatternOptions = {},
): Promise<ProcessInfo[]> {
  return findByPatternAsync(escapeLiteral(pattern), options);
}

/** Bounded, interruptible process query; ps failures never degrade to blank commands. */
export async function findByPatternAsync(
  pattern: string,
  options: FindByPatternOptions = {},
): Promise<ProcessInfo[]> {
  const pgrep = await runListingProcess('pgrep', ['-f', pattern], pattern, options);
  if (pgrep.status === 1) return [];
  if (pgrep.status !== 0) throw nonzeroExit(pattern, 'pgrep', pgrep.status, pgrep.stderr);

  const pids = parsePids(pgrep.stdout);
  if (pids.length === 0) return [];

  const ps = await runListingProcess(
    'ps',
    ['-o', 'pid=,command=', '-p', pids.join(',')],
    pattern,
    options,
  );
  if (ps.status !== 0) throw nonzeroExit(pattern, 'ps', ps.status, ps.stderr);
  return parseProcessList(ps.stdout);
}
