/**
 * ProcessExec types (L1)
 *
 * External process execution interface.
 */

/**
 * Minimum allowed exec timeout (ms) - clamp lower bound.
 *
 * Value: 1000 (1s) = empirical floor / < 1s 任何 real exec 都不充分
 * （Node.js cold-start ~50-200ms + user logic 需余量）.
 */
export const PROCESS_EXEC_TIMEOUT_MIN_MS = 1000;
/**
 * Maximum allowed exec timeout (ms) - clamp upper bound.
 *
 * Value: 600_000 (10 min) = aligned with L4 `tool_timeout_ms` config schema max
 * (`foundation/config/schemas.ts:87` max(600000)).
 * phase 1033 (timeout 全栈 F-3) — pre-1033 = 120_000 (2 min) silent-clamped
 * user config 600_000 to 120_000.
 * Residual: caller > 600_000 still silent clamp (推 follow-up γ-audit-emit
 * or ε-validate-throw if 真 incident).
 */
export const PROCESS_EXEC_TIMEOUT_MAX_MS = 600_000;
/**
 * Default exec timeout if not specified (ms).
 *
 * Value: 30_000 (30s) = empirical balance / 覆盖 git / ls / grep / build
 * 等大多数 exec / 不命中 user 配置覆盖.
 */
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
  /** Content to pipe to the child process stdin (phase 1321) */
  stdin?: string;
}

export interface ExecResult {
  /** Combined stdout + stderr in chronological order */
  output: string;
  /** Process exit code */
  exitCode: number;
  /** Separated stderr when available (snapshot layer defense, backward-compatible) */
  stderr?: string;
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
    stderr?: string;
  }) {
    super(options.message);
    this.name = 'ProcessExecError';
    this.output = options.output ?? '';
    this.exitCode = options.exitCode ?? null;
    this.code = options.code;
    this.signal = options.signal;
    this.killed = options.killed ?? false;
    this.maxBufferExceeded = options.maxBufferExceeded ?? false;
    // stderr preserved on error for diagnostics (phase1062)
    if (options.stderr) {
      (this as any).stderr = options.stderr;
    }
  }
}
