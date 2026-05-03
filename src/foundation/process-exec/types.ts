/**
 * ProcessExec types (L1)
 *
 * External process execution interface.
 */

export const PROCESS_EXEC_TIMEOUT_MIN_MS = 1000;
export const PROCESS_EXEC_TIMEOUT_MAX_MS = 120_000;
export const PROCESS_EXEC_DEFAULT_TIMEOUT_MS = 30_000;
export interface ExecOptions {
  /** Working directory (required) */
  cwd: string;
  /** Timeout in ms, clamped to [MIN, MAX] */
  timeout?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface ExecResult {
  /** Raw stdout */
  stdout: string;
  /** Raw stderr */
  stderr: string;
  /** Process exit code */
  exitCode: number;
}

/**
 * Error thrown when process execution fails.
 * Carries raw output for consumer diagnostics.
 */
export interface SpawnDetachedOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  logFile?: string;       // 内部 open/close fd 包装
}

export class ProcessExecError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly code?: string;
  readonly signal?: string;
  readonly killed: boolean;
  readonly maxBufferExceeded: boolean;

  constructor(options: {
    message: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    code?: string;
    signal?: string;
    killed?: boolean;
    maxBufferExceeded?: boolean;
  }) {
    super(options.message);
    this.name = 'ProcessExecError';
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
    this.exitCode = options.exitCode ?? null;
    this.code = options.code;
    this.signal = options.signal;
    this.killed = options.killed ?? false;
    this.maxBufferExceeded = options.maxBufferExceeded ?? false;
  }
}
