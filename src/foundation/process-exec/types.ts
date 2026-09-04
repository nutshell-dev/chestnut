/**
 * ProcessExec types (L1)
 *
 * Interface types only. Constants live in `constants.ts`; error classes in `errors.ts`.
 */

interface ExecBaseOptions {
  /** Working directory (required) */
  cwd: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Environment variables for child process. If provided, only these + PATH are passed (no process.env inheritance). If omitted, inherits all of process.env. */
  env?: Record<string, string>;
  /** Content to pipe to the child process stdin (phase 1321) */
  stdin?: string;
  /**
   * Synchronous observation point for a newly-created OS execution identity.
   * Called after the handle is fully wired and before execWithHandle returns,
   * allowing an upper layer to durably checkpoint ownership without polling
   * ChildProcess internals. L1 supplies only its neutral identity fact.
   */
  onExecutionIdentity?: (identity: ExecutionIdentity) => void;
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

/**
 * Timeout scheduling policy (phase 1272 Step B) — exactly one of two
 * L1-neutral strategies, mutually exclusive at the type level:
 *
 * - relative `timeout` (ms): business-facing budget; defaults to
 *   PROCESS_EXEC_DEFAULT_TIMEOUT_MS and is clamped to
 *   [PROCESS_EXEC_TIMEOUT_MIN_MS, PROCESS_EXEC_TIMEOUT_MAX_MS].
 * - absolute `deadlineAtMs` (epoch ms): a neutral wall-clock fact supplied by
 *   the caller; NOT subject to the relative business clamp. The runtime timer
 *   delay is derived from `deadlineAtMs - Date.now()` and re-derived on every
 *   segment fire, so a deadline beyond the Node single-timer cap or a backward
 *   clock jump can never collapse into a 1ms misfire.
 *
 * Passing both (or neither field name spelled differently) is a compile-time
 * error — no special numeric values (0/Infinity/null) act as hidden protocol.
 */
type ExecTimeoutPolicy =
  | {
      /** Timeout in ms, clamped to [PROCESS_EXEC_TIMEOUT_MIN_MS, PROCESS_EXEC_TIMEOUT_MAX_MS] */
      timeout?: number;
      deadlineAtMs?: never;
    }
  | {
      timeout?: never;
      /** Absolute wall-clock deadline (epoch ms); must be a positive safe integer. */
      deadlineAtMs: number;
    };

export type ExecOptions = ExecBaseOptions & ExecTimeoutPolicy;

export interface ExecResult {
  /** Combined stdout + stderr in chronological order */
  output: string;
  /** Process exit code */
  exitCode: number;
  /** Separated stderr when available (snapshot layer defense, backward-compatible) */
  stderr?: string;
}

/**
 * Why a normal exec timed out / was asked to terminate.
 * L1-neutral: L4 business reasons (persist failed / hard deadline / recovery)
 * stay in the caller's own audit context, not in this union.
 */
export type ExecutionTerminationTrigger =
  | 'timeout'
  | 'max_buffer'
  | 'abort'
  | 'caller_requested';

/**
 * OS-level identity of one execution unit. A normal exec spawns its child as
 * an isolated POSIX process-group leader (`detached: true`), so the group id
 * equals the leader pid. Never fabricated: absent when spawn itself failed.
 */
export interface ExecutionIdentity {
  leaderPid: number;
  processGroupId: number;
}

/**
 * Structured conclusion of one termination state-machine run
 * (TERM group → grace → KILL group → bounded confirmation).
 * `signal sent`, `leader gone` and `group gone` are different facts and must
 * not be flattened into a boolean.
 */
export type ExecutionTerminationOutcome =
  | {
      status: 'gone';
      identity: ExecutionIdentity;
      trigger: ExecutionTerminationTrigger;
      termSent: boolean;
      killSent: boolean;
      completedAt: string;
    }
  | {
      status: 'still_alive';
      identity: ExecutionIdentity;
      trigger: ExecutionTerminationTrigger;
      termSent: boolean;
      killSent: boolean;
      checkedAt: string;
    }
  | {
      status: 'indeterminate';
      identity: ExecutionIdentity;
      trigger: ExecutionTerminationTrigger;
      termSent: boolean;
      killSent: boolean;
      checkedAt: string;
      reason: string;
    };

/**
 * Error-facing termination fact carried by ProcessExecError. Same facts as
 * ExecutionTerminationOutcome, flattened for cross-layer diagnostics, plus
 * the not-started case (pre-aborted signal): no execution unit — and thus no
 * identity — ever existed, and none is fabricated.
 */
export interface ExecutionTerminationFact {
  status: 'gone' | 'still_alive' | 'indeterminate';
  trigger: ExecutionTerminationTrigger;
  termSent: boolean;
  killSent: boolean;
  /** Present for real execution units; absent only when nothing was started. */
  identity?: ExecutionIdentity;
  /** Present when status is 'indeterminate' or the unit never started. */
  reason?: string;
}

/**
 * Handle returned by execWithHandle: exposes the settled promise, the live
 * ChildProcess (streams/unref only — callers MUST NOT use child.kill; OS
 * signal semantics stay L1-owned via `terminate()`), the execution identity,
 * and the single idempotent termination entry point.
 */
export interface ExecHandle {
  promise: Promise<ExecResult>;
  child: import('child_process').ChildProcess;
  /** Present when the OS process exists; absent only if spawn itself failed. */
  identity?: ExecutionIdentity;
  /**
   * Idempotent: concurrent/repeat calls share the first in-flight run; the
   * first trigger and earliest SIGKILL deadline always win.
   * The trigger is the L1 termination word (default 'caller_requested'); L4
   * business reasons stay in the caller's own audit context, never in this
   * parameter.
   */
  terminate(trigger?: ExecutionTerminationTrigger): Promise<ExecutionTerminationOutcome>;
}

export interface ProcessInfo {
  pid: number;
  command: string;
}

/**
 * phase 1763: detached spawn 失败事实 — 原始 errno / 时间 / 命令身份无损保留。
 * 提交点前失败随 SpawnDetachedOutcome 返回；提交点后失败经 failure sink 交付。
 */
export interface SpawnDetachedFailure {
  /** 被 spawn 的命令（身份证据，不含 CLI 私有格式） */
  command: string;
  /** 参数快照（identity 辅助） */
  args: readonly string[];
  /** 仅 post-commit 失败存在（进程已拿到 pid 后死亡/执行失败） */
  pid?: number;
  /** 标准化 errno：优先 Node 字符串 code（如 'ENOENT'），退化为数字 errno */
  errno?: number | string;
  /** Node 原始 code（与 errno 可能同值） */
  code?: number | string;
  message: string;
  /** 观察时间（epoch ms） */
  atMs: number;
}

/**
 * phase 1763: detached spawn typed outcome。
 * 提交点 = child 'spawn' 事件成功交付且 pid 已存在（Phase 1762 冻结设计）；
 * 提交点前同步/异步错误一律走 failed 变体，禁止只返回成功 pid。
 */
export type SpawnDetachedOutcome =
  | { kind: 'spawned'; pid: number }
  | { kind: 'failed'; failure: SpawnDetachedFailure };

export interface SpawnDetachedOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  logFile?: string;       // 内部 open/close fd 包装
  /**
   * phase 1763: post-commit failure sink。提交点后异步错误（exec 失败等）
   * 经此交付 owner（至少 pid/command/errno/时间）。sink 自身抛错不得静默：
   * fallback 到 stderr。未注入时默认 console.error — 任何情况下错误都不被吞。
   */
  onSpawnFailure?: (failure: SpawnDetachedFailure) => void;
}
