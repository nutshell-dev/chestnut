/**
 * ProcessExec types (L1)
 *
 * Interface types only. Constants live in `constants.ts`; error classes in `errors.ts`.
 */

export interface ExecOptions {
  /** Working directory (required) */
  cwd: string;
  /** Timeout in ms, clamped to [PROCESS_EXEC_TIMEOUT_MIN_MS, PROCESS_EXEC_TIMEOUT_MAX_MS] */
  timeout?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Environment variables for child process. If provided, only these + PATH are passed (no process.env inheritance). If omitted, inherits all of process.env. */
  env?: Record<string, string>;
  /** Content to pipe to the child process stdin (phase 1321) */
  stdin?: string;
  /**
   * Max combined stdout+stderr bytes before SIGTERM is delivered.
   * Defaults to PROCESS_EXEC_DEFAULT_MAX_BUFFER (1 MiB) when omitted.
   * Use to opt-in to higher limits for known-large outputs; sub-1 byte
   * values are coerced to 1 to avoid divide-by-zero in error messages.
   * (phase 1385 G5 / claim 3)
   */
  maxBuffer?: number;
  /**
   * Test-only override for PROCESS_EXEC_TIMEOUT_MIN_MS (default 1000ms).
   * Production callers MUST NOT use this — it bypasses the empirical floor
   * for real exec. Sole purpose: cut test wall (phase 1394) for tests
   * that deliberately trigger timeout/SIGKILL paths with a short window.
   */
  __testMinTimeoutMs?: number;
  /**
   * Test-only override for PROCESS_EXEC_SIGKILL_GRACE_MS (default 1000ms).
   * Production callers MUST NOT use this — POSIX 行业 graceful 期被绕过。
   * Sole purpose: cut SIGTERM→SIGKILL grace in test for fast escalation paths
   * (phase 1394).
   */
  __testSigkillGraceMs?: number;
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
 * Handle returned by execWithHandle: exposes both the settled promise and the
 * live ChildProcess. Callers own the child lifecycle (kill / detach / wait).
 */
export interface ExecHandle {
  promise: Promise<ExecResult>;
  child: import('child_process').ChildProcess;
}

export interface ProcessInfo {
  pid: number;
  command: string;
}

export interface SpawnDetachedOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  logFile?: string;       // 内部 open/close fd 包装
}
