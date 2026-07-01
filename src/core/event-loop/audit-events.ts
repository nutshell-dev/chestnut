export const EVENTLOOP_AUDIT_EVENTS = {
  /** 轮次消费编排完成 */
  ITERATION: 'eventloop_iteration',
  /** 进入退避重试 */
  LLM_RETRY: 'eventloop_llm_retry',
  /** 退避重试耗尽，进入限流等待 */
  COOLDOWN: 'eventloop_cooldown',
  /** 调度层异常 */
  FATAL: 'eventloop_fatal',
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
