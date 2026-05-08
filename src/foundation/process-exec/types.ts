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
  /** Environment variables for child process. If provided, only these + PATH are passed (no process.env inheritance). If omitted, inherits all of process.env. */
  env?: Record<string, string>;
}

export interface ExecResult {
  /** Combined stdout + stderr in chronological order */
  output: string;
  /** Process exit code */
  exitCode: number;
}

/**
 * Error thrown when process execution fails.
 * Carries raw output for consumer diagnostics.
 */
export interface ProcessInfo {
  pid: number;
  command: string;
}

export interface SpawnDetachedOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  logFile?: string;       // 内部 open/close fd 包装
}

export class ProcessExecError extends Error {
  readonly output: string;
  readonly exitCode: number | null;
  readonly code?: string;
  readonly signal?: string;
  readonly killed: boolean;
  readonly maxBufferExceeded: boolean;

  constructor(options: {
    message: string;
    output?: string;
    exitCode?: number | null;
    code?: string;
    signal?: string;
    killed?: boolean;
    maxBufferExceeded?: boolean;
  }) {
    super(options.message);
    this.name = 'ProcessExecError';
    this.output = options.output ?? '';
    this.exitCode = options.exitCode ?? null;
    this.code = options.code;
    this.signal = options.signal;
    this.killed = options.killed ?? false;
    this.maxBufferExceeded = options.maxBufferExceeded ?? false;
  }
}
