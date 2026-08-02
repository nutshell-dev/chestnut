/**
 * ProcessExec constants (L1)
 *
 * Timeout bounds and defaults for external process execution.
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

/**
 * Default maxBuffer for exec output (bytes).
 *
 * Value: 1_048_576 (1 MiB) = empirical balance / 覆盖典型命令输出 / 防止
 * runaway 输出耗尽 memory. caller 可通过 `ExecOptions.maxBuffer` 覆盖
 * （phase 1385 G5）.
 */
export const PROCESS_EXEC_DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * SIGTERM → SIGKILL escalation grace period (ms) for exec'd user processes.
 *
 * Value: 1000 = POSIX 行业 SIGTERM grace period（systemd / kubelet / Docker
 * stack 最小 graceful 单位）.
 * 与 `WATCHDOG_SIGKILL_GRACE_MS = 500` (cli/commands/watchdog-cli.ts) 故意值不同：
 *   - EXEC:    1000ms — user process、POSIX 行业
 *   - WATCHDOG: 500ms — watchdog daemon、更快 cleanup
 */
export const PROCESS_EXEC_SIGKILL_GRACE_MS = 1000;

/**
 * Bounded confirmation window (ms) after SIGKILL is sent to an execution
 * group: L1 polls group liveness until the group is gone or this budget is
 * exhausted, after which the outcome is honestly `still_alive`.
 *
 * Value: 1000 = same POSIX industry granularity as the TERM grace; SIGKILL is
 * not maskable, so a group still responding after 1s indicates an OS-level
 * anomaly (unkillable D-state etc.) that must surface, not be hidden.
 */
export const PROCESS_EXEC_GROUP_KILL_CONFIRM_MS = 1000;

/**
 * Poll interval (ms) for post-SIGKILL group-gone confirmation.
 *
 * Value: 25 = small vs the 1000ms confirm budget, so a normal kill is
 * confirmed within ~1-2 polls without busy-looping the event loop.
 */
export const PROCESS_EXEC_GROUP_CONFIRM_POLL_MS = 25;
