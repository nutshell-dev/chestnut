/** Default maximum concurrent tasks */
export const DEFAULT_MAX_CONCURRENT_TASKS = 3;

/**
 * AsyncTaskSystem retry exponential backoff base delay (ms).
 * 失败 task retry 首次延迟、后续 retry 用 `baseDelay * 2^attempt`。
 * Default = 500ms 行业 retry backoff 经验值（< 1s, 0 starvation 风险）。
 */
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/**
 * Shutdown remaining task promises drain grace cap.
 * phase 779 Step B: AsyncTaskSystem.shutdown() drains pendingCleanups after task-timeout race
 * using `Promise.race([allSettled(remainingPromises), setTimeout(grace)])` to avoid indefinite
 * hangs on misbehaving tasks. 1s grace = 同 `EXEC_SIGKILL_GRACE_MS` (foundation/process-exec/exec.ts)
 * + POSIX SIGTERM grace period industry default 模板 mirror.
 * phase 863 const promote (r111 J fork / `feedback_config_defaults_single_source`).
 */
export const SHUTDOWN_DRAIN_GRACE_MS = 1000;

/**
 * AsyncTaskSystem.shutdown() default timeoutMs.
 * Caller 不传 timeoutMs 时使用此默认值；超过此时间未 drain 完则 timedOut=true 返 false。
 * 与 SHUTDOWN_DRAIN_GRACE_MS 独立可变（前者是整体 shutdown 上限、后者是 task race 后 cleanup grace）。
 * phase 105 const 化（修 phase 1xx pre-existing system.ts:704 inline default、playbook §fallback default 子型）
 */
export const SHUTDOWN_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Pending queue 上限 / 达此 cap 时 schedule 触发 reject + audit emit
 * + notify motion (overflow notification per phase 670).
 */
export const PENDING_QUEUE_MAX = 1000;
