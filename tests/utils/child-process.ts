import { spawn } from 'node:child_process';

export interface RunChildProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  killGraceMs?: number;
}

export interface ChildProcessResult {
  command: string;
  args: string[];
  pid?: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface ChildProcessTimeoutDetails extends ChildProcessResult {
  timeoutMs: number;
  killSignals: NodeJS.Signals[];
  killError?: unknown;
  cleanup: 'closed';
}

export class ChildProcessTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(readonly details: ChildProcessTimeoutDetails, cause: Error) {
    const command = [details.command, ...details.args]
      .map(part => JSON.stringify(part))
      .join(' ');
    super(
      `Child process timed out: command=${command} pid=${details.pid ?? 'unknown'} ` +
      `timeoutMs=${details.timeoutMs} killSignals=${details.killSignals.join(',') || 'none'} ` +
      `status=${details.status ?? 'null'} signal=${details.signal ?? 'null'} cleanup=${details.cleanup}`,
      { cause },
    );
    this.name = 'ChildProcessTimeoutError';
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isBrokenPipe(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'EPIPE';
}

/**
 * Run a test-owned child without blocking the Vitest worker. A timeout is a
 * lifecycle failure, not a business result: kill only this child, await close,
 * then throw with the original ETIMEDOUT cause and exit evidence.
 */
export async function runChildProcess(
  command: string,
  args: string[],
  options: RunChildProcessOptions,
): Promise<ChildProcessResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'pipe',
  });
  const pid = child.pid;
  let stdout = '';
  let stderr = '';
  let processError: Error | undefined;
  let inputError: Error | undefined;
  let closed = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', error => { processError = error; });
  child.stdin.once('error', error => {
    // The CLI may reject before reading stdin; EPIPE is expected in that path.
    if (!isBrokenPipe(error)) inputError = error;
  });
  child.stdin.end(options.input);

  const close = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (status, signal) => {
      closed = true;
      resolve({ status, signal });
    });
  });

  const cause = Object.assign(
    new Error(`spawn ${command} ETIMEDOUT`),
    {
      code: 'ETIMEDOUT',
      syscall: 'spawn',
      path: command,
      spawnargs: args,
    },
  );
  const killSignals: NodeJS.Signals[] = [];
  let killError: unknown;
  const requestKill = (signal: NodeJS.Signals): void => {
    try {
      if (child.kill(signal)) killSignals.push(signal);
    } catch (error) {
      killError = error;
    }
  };

  let timer: NodeJS.Timeout | undefined;
  let escalation: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      requestKill('SIGTERM');
      escalation = setTimeout(() => {
        if (!closed) requestKill('SIGKILL');
      }, options.killGraceMs ?? 1_000);
      resolve();
    }, options.timeoutMs);
  });

  try {
    const outcome = await Promise.race([close, timeout]);
    if (outcome === undefined) {
      // Do not race close again here: timeout has already won and must not be
      // converted into a normal signal-exit result when close resolves.
      const { status, signal } = await close;
      throw new ChildProcessTimeoutError({
        command,
        args,
        pid,
        status,
        signal,
        stdout,
        stderr,
        error: processError ?? inputError,
        timeoutMs: options.timeoutMs,
        killSignals,
        killError,
        cleanup: 'closed',
      }, cause);
    }
    return {
      command,
      args,
      pid,
      status: outcome.status,
      signal: outcome.signal,
      stdout,
      stderr,
      error: processError ?? inputError,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
  }
}

/** Await cleanup and retain both failures instead of masking the test cause. */
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
