export const EVENTLOOP_AUDIT_EVENTS = {
  /** 轮次消费编排完成 */
  ITERATION: 'eventloop_iteration',
  /** 进入退避重试 */
  LLM_RETRY: 'eventloop_llm_retry',
  /** 退避重试耗尽，进入限流等待 */
  COOLDOWN: 'eventloop_cooldown',
  /** 调度层异常 */
  FATAL: 'eventloop_fatal',
  /** Phase 1154: LLM request 被阻断（context trim 无进展 / retry 耗尽 / invalid_request） */
  CONTEXT_BLOCKED: 'eventloop_context_blocked',
  /** Phase 1154: pre-drain request gate 阻止本次 tick（same fingerprint） */
  CONTEXT_BLOCKED_GATE: 'eventloop_context_blocked_gate',
  /** Phase 1154: peek pending 失败导致 request gate 无法判定 */
  CONTEXT_BLOCKED_PEEK_FAILED: 'eventloop_context_blocked_peek_failed',
  /** Phase 1154: request blocked 状态因 fingerprint 变化解除 */
  CONTEXT_BLOCKED_RELEASED: 'eventloop_context_blocked_released',
  /** phase 1778: 启动 = 干预信号——initialize 清除 blocked 放行一次探测 */
  CONTEXT_BLOCKED_STARTUP_PROBE: 'eventloop_context_blocked_startup_probe',
  /** Phase 1158: post-drain pipeline 异常后 nack 恢复并审计 */
  POST_DRAIN_FAILURE_RECOVERED: 'eventloop_post_drain_failure_recovered',
  /** Phase 1396 Step E: 检测到执行停滞，向自身 inbox enqueue 高优 resume（attempt 已落盘） */
  EXECUTION_RECOVERY_RESUME: 'eventloop_execution_recovery_resume',
  /** Phase 1396 Step E: activity 前进 / contract 不再 active → recovery record 复位删除 */
  EXECUTION_RECOVERY_RESET: 'eventloop_execution_recovery_reset',
  /** Phase 1396 Step E: 恢复耗尽，execution failure 已交付 ExecutionFailureSink */
  EXECUTION_RECOVERY_FAILURE_DELIVERED: 'eventloop_execution_recovery_failure_delivered',
  /** Phase 1396 Step E: failure 交付失败，保留 record 下 tick 重试交付 */
  EXECUTION_RECOVERY_DELIVERY_FAILED: 'eventloop_execution_recovery_delivery_failed',
} as const;

export const LOOP_ITERATION_TYPES = {
  chain: 'chain',
  chain_limited: 'chain_limited',
  wait: 'wait',
} as const;

export const LOOP_INTERRUPT_CAUSES = {
  idle_timeout: 'idle_timeout',
  user_interrupt: 'user_interrupt',
  priority_inbox: 'priority_inbox',
} as const;

/**
 * Phase 159 业主声明 file 归属：eventloop_iteration 高频 tick 其余默认 audit.
 */
export const EVENTLOOP_FILE_ROUTING: Readonly<Record<string, 'audit' | 'tick'>> = {
  eventloop_iteration: 'tick',
} as const;
