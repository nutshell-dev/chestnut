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

/** Maximum time cancel() waits for a running task to cooperate after abort. */
export const CANCEL_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Pending queue 上限 / 达此 cap 时 schedule 触发 reject + audit emit
 * + notify motion (overflow notification per phase 670).
 */
export const PENDING_QUEUE_MAX = 1000;

/**
 * Phase 770: default soft timeout for async exec wrapper.
 * Commands running longer than this are migrated to background async execution
 * instead of blocking the agent turn.
 */
export const ASYNC_EXEC_SOFT_TIMEOUT_MS = 10_000;

/**
 * phase 1391 Step B: SubAgentTask task-level stall threshold (ms).
 * Running + task stream 无活动 + 无 turn 在飞，超过此窗口视为任务级等待态停滞，
 * 推送 task_stage_update 阶段消息给父 claw（同 waiting-stall 5min 同量级）。
 */
export const SUBAGENT_TASK_STALL_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * phase 1391 Step B: 推送阶段消息后仍停滞的判失败窗口（ms）。
 * 推送 → 子代理仍未恢复 → moveTaskToFailed + is_error task_result 叫醒父 claw。
 */
export const SUBAGENT_TASK_STALL_FAIL_AFTER_MS = 5 * 60 * 1000;

/**
 * phase 1391 Step B: stall 检测器扫描节拍（ms）。与 waiting-stall 60s 节拍同量级。
 */
export const SUBAGENT_TASK_STALL_CHECK_INTERVAL_MS = 60_000;

